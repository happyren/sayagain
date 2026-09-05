/**
 * One span per tools/call, exported over OTLP/HTTP (JSON) to whatever the
 * operator already runs. Attributes follow ADR-0007: GenAI semantic
 * conventions plus sayagain.* keys. Error signatures leave as a hash unless
 * the operator opts in; argument values never leave at all.
 */
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { LedgerRow } from "./ledger.js";

export interface OtlpOptions {
  /** The traces endpoint, e.g. http://127.0.0.1:4318/v1/traces. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  version?: string;
  /** Export masked error signatures as text rather than a hash. Default false. */
  signatures?: boolean;
  batchSize?: number;
  flushMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

type Attr = {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { arrayValue: { values: { stringValue: string }[] } };
};

const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(Math.round(v)) } });
const bool = (key: string, v: boolean): Attr => ({ key, value: { boolValue: v } });
const strs = (key: string, v: string[]): Attr => ({
  key,
  value: { arrayValue: { values: v.map((s) => ({ stringValue: s })) } },
});

const hex = (buf: Buffer): string => buf.toString("hex");
const nanos = (ms: number): string => `${Math.round(ms)}000000`;

/** Attributes for one ledger row. Exported for tests and for anyone building their own exporter. */
export function spanAttributes(row: LedgerRow, opts: { signatures?: boolean } = {}): Attr[] {
  const attrs: Attr[] = [
    str("gen_ai.operation.name", "execute_tool"),
    str("gen_ai.tool.name", row.tool),
    str("gen_ai.tool.call.id", row.receipt),
    str("mcp.server.name", row.upstream),
    str("mcp.method", row.method),
    str("sayagain.receipt", row.receipt),
    str("sayagain.status", row.status),
    str("sayagain.tool_class", row.toolClass),
    strs("sayagain.args.shape", row.argShape),
    bool("sayagain.intent.present", row.hasIntent),
    int("sayagain.request.bytes", row.requestBytes),
    int("sayagain.response.bytes", row.responseBytes),
  ];
  if (row.task !== undefined) attrs.push(str("sayagain.task", row.task));
  if (row.session !== undefined) attrs.push(str("sayagain.session", row.session));
  if (row.errorClass) attrs.push(str("sayagain.error.class", row.errorClass));
  if (row.errorCode !== undefined) attrs.push(int("sayagain.error.code", row.errorCode));
  if (row.errorSignature)
    attrs.push(
      opts.signatures
        ? str("sayagain.error.signature", row.errorSignature)
        : str(
            "sayagain.error.signature_hash",
            createHash("sha256").update(row.errorSignature).digest("hex").slice(0, 16),
          ),
    );
  if (row.attempts !== undefined) attrs.push(int("sayagain.attempts", row.attempts));
  if (row.repairs?.length) {
    attrs.push(str("sayagain.repair.kind", "coerce"));
    attrs.push(
      strs(
        "sayagain.repair.rule",
        row.repairs.map((r) => `${r.path} ${r.rule}`),
      ),
    );
  }
  if (row.held) {
    attrs.push(str("sayagain.held.mode", row.held.mode));
    attrs.push(
      str(
        "sayagain.held.decision",
        row.held.cancelled ? "cancelled" : (row.held.decision ?? "expired"),
      ),
    );
    if (row.held.waitedMs !== undefined)
      attrs.push(int("sayagain.held.waited_ms", row.held.waitedMs));
  }
  if (row.duplicateOf) attrs.push(str("sayagain.duplicate_of", row.duplicateOf));
  if (row.replayOf) attrs.push(str("sayagain.replay_of", row.replayOf));
  return attrs;
}

export class OtlpExporter {
  private buffer: unknown[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly doFetch: typeof fetch;
  private readonly log: (line: string) => void;
  private failures = 0;
  private closed = false;
  constructor(private readonly opts: OtlpOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** Queue a span for the row. Spans are batched; nothing blocks the call path. */
  record(row: LedgerRow): void {
    if (this.closed) return;
    const end = Date.parse(row.ts) + row.latencyMs;
    const start = Date.parse(row.ts);
    const traceId = hex(createHash("sha256").update(row.receipt).digest().subarray(0, 16));
    const span = {
      traceId,
      spanId: hex(randomBytes(8)),
      name: `tools/call ${row.tool}`,
      kind: 3, // CLIENT
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(Math.max(end, start)),
      attributes: spanAttributes(row, { signatures: this.opts.signatures ?? false }),
      status: row.isError ? { code: 2, message: row.errorClass ?? "error" } : { code: 1 },
      events: [
        ...(row.held
          ? [
              {
                name: `hold.${row.held.cancelled ? "cancelled" : (row.held.decision ?? "expired")}`,
                timeUnixNano: nanos(end),
              },
            ]
          : []),
        ...(row.status === "dead-lettered"
          ? [{ name: "dead-letter", timeUnixNano: nanos(end) }]
          : []),
        ...(row.replayOf ? [{ name: "replay", timeUnixNano: nanos(start) }] : []),
      ],
    };
    this.buffer.push(span);
    if (this.buffer.length >= (this.opts.batchSize ?? 100)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 2000);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.buffer.length) return;
    const spans = this.buffer;
    this.buffer = [];
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              str("service.name", this.opts.serviceName ?? "sayagain"),
              str("service.version", this.opts.version ?? "0"),
            ],
          },
          scopeSpans: [{ scope: { name: "sayagain", version: this.opts.version ?? "0" }, spans }],
        },
      ],
    };
    try {
      const res = await this.doFetch(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.failures = 0;
    } catch (err) {
      this.failures++;
      if (this.failures <= 3 || this.failures % 50 === 0)
        this.log(
          `sayagain: OTLP export to ${this.opts.endpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}

/** The OTLP traces endpoint the environment names, if any (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, else OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces). */
export function otlpEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) return traces;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base) return `${base.replace(/\/$/, "")}/v1/traces`;
  return undefined;
}

/** OTEL_EXPORTER_OTLP_HEADERS ("k=v,k2=v2") as an object. */
export function otlpHeadersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** Is something listening on the default local OTLP/HTTP port? A cheap probe, so the export can be on by default. */
export function localCollectorListening(
  port = 4318,
  host = "127.0.0.1",
  timeoutMs = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Resolve where to export: an explicit endpoint, the environment, or a local collector if one answers. */
export async function resolveOtlpEndpoint(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (explicit === "off") return undefined;
  if (explicit) return explicit;
  const fromEnv = otlpEndpointFromEnv(env);
  if (fromEnv) return fromEnv;
  return (await localCollectorListening()) ? "http://127.0.0.1:4318/v1/traces" : undefined;
}
