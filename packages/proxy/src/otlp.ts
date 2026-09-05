/**
 * One span per tools/call, exported over OTLP/HTTP (JSON) to whatever the
 * operator already runs. Attributes follow ADR-0007: GenAI semantic
 * conventions plus sayagain.* keys. Error signatures and task ids leave as
 * hashes (grouping keys, not secrets) unless the operator opts in; argument
 * values never leave at all.
 */
import { createHash, randomBytes } from "node:crypto";
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
/** A grouping key, not a secret: the first 64 bits of SHA-256 of the text. */
const hash16 = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
const nanos = (ms: number): string => `${Math.round(ms)}000000`;
const holdOutcome = (held: NonNullable<LedgerRow["held"]>): string =>
  held.cancelled ? "cancelled" : (held.decision ?? "undecided");

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
  if (row.server !== undefined) attrs.push(str("sayagain.server", row.server));
  // A task id may be free text; only a hash leaves (ADR-0005).
  if (row.task !== undefined) attrs.push(str("sayagain.task_hash", hash16(row.task)));
  if (row.session !== undefined) attrs.push(str("sayagain.session", row.session));
  if (row.errorClass) attrs.push(str("sayagain.error.class", row.errorClass));
  if (row.errorCode !== undefined) attrs.push(int("sayagain.error.code", row.errorCode));
  if (row.errorSignature)
    attrs.push(
      opts.signatures
        ? str("sayagain.error.signature", row.errorSignature)
        : str("sayagain.error.signature_hash", hash16(row.errorSignature)),
    );
  if (row.attempts !== undefined || row.held)
    attrs.push(int("sayagain.attempt", row.attempts ?? 1));
  if (row.attempts !== undefined) attrs.push(int("sayagain.attempts", row.attempts));
  if (row.repairs?.length) {
    const kinds = new Set(
      row.repairs.map((r) =>
        r.rule === "rename" ? "rename" : r.rule === "default" ? "default" : "coerce",
      ),
    );
    attrs.push(str("sayagain.repair.kind", [...kinds].join(",")));
    attrs.push(
      strs(
        "sayagain.repair.rule",
        row.repairs.map((r) => `${r.path} ${r.rule}`),
      ),
    );
  }
  if (row.held) {
    attrs.push(str("sayagain.held.mode", row.held.mode));
    attrs.push(str("sayagain.held.decision", holdOutcome(row.held)));
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
  private readonly inFlight = new Set<Promise<void>>();
  private failures = 0;
  private closed = false;
  constructor(private readonly opts: OtlpOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  get endpoint(): string {
    return this.opts.endpoint;
  }

  /** Queue a span for the row. Spans are batched; nothing blocks the call path. */
  record(row: LedgerRow): void {
    if (this.closed) return;
    const start = Date.parse(row.ts);
    const end = start + row.latencyMs;
    // Every row of one receipt shares a trace; the first attempt is the root, later rows its children.
    const digest = createHash("sha256").update(row.receipt).digest();
    const traceId = hex(digest.subarray(0, 16));
    const rootSpanId = hex(digest.subarray(16, 24));
    const followUp = (row.attempts ?? 1) > 1 || row.held !== undefined || row.status === "repaired";
    const span = {
      traceId,
      spanId: followUp ? hex(randomBytes(8)) : rootSpanId,
      ...(followUp ? { parentSpanId: rootSpanId } : {}),
      name: `tools/call ${row.tool}`,
      kind: 3, // CLIENT
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(Math.max(end, start)),
      attributes: spanAttributes(row, { signatures: this.opts.signatures ?? false }),
      status: row.isError ? { code: 2, message: row.errorClass ?? "error" } : { code: 1 },
      events: [
        ...(row.held ? [{ name: `hold.${holdOutcome(row.held)}`, timeUnixNano: nanos(end) }] : []),
        ...(row.status === "dead-lettered"
          ? [{ name: "dead-letter", timeUnixNano: nanos(end) }]
          : []),
        ...(row.replayOf ? [{ name: "replay", timeUnixNano: nanos(start) }] : []),
      ],
    };
    this.buffer.push(span);
    // A collector that is down must not eat memory: keep the newest five thousand.
    if (this.buffer.length > 5000) this.buffer.splice(0, this.buffer.length - 5000);
    if (this.buffer.length >= (this.opts.batchSize ?? 100)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 2000);
      this.timer.unref();
    }
  }

  /** Send what is buffered now. Resolves when that batch has been sent (or given up on). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.buffer.length) return;
    const spans = this.buffer;
    this.buffer = [];
    const p = this.send(spans).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    await p;
    await Promise.allSettled([...this.inFlight]); // and any batch that was already on its way
  }

  private async send(spans: unknown[], retried = false): Promise<void> {
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
        headers: { ...(this.opts.headers ?? {}), "content-type": "application/json" },
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
      if (!retried) {
        // One more try after a pause; after that the batch is dropped rather than queued forever.
        await new Promise((r) => setTimeout(r, this.closed ? 100 : 1000).unref());
        await this.send(spans, true);
      }
    }
  }

  /** Flush what is buffered and wait for every batch in flight. Records after this are dropped. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
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

/** OTEL_EXPORTER_OTLP_HEADERS ("k=v,k2=v2") as an object. Values may be percent-encoded. */
export function otlpHeadersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const raw = pair.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // not percent-encoded; use it as written
    }
    out[pair.slice(0, i).trim()] = value;
  }
  return out;
}

/**
 * Is an OTLP/HTTP collector answering on the default local port? A bare TCP connect is not enough,
 * since anything could own 4318: an empty traces request must come back 2xx.
 */
export async function localCollectorListening(
  port = 4318,
  host = "127.0.0.1",
  timeoutMs = 300,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch(`http://${host}:${port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve where to export: off when asked (explicitly, or SAYAGAIN_OTLP=off / OTEL_SDK_DISABLED=true),
 * else an explicit endpoint, else the environment, else a local collector if one answers.
 */
export async function resolveOtlpEndpoint(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (explicit === "off" || env.SAYAGAIN_OTLP === "off" || env.OTEL_SDK_DISABLED === "true")
    return undefined;
  if (explicit) return explicit;
  const fromEnv = otlpEndpointFromEnv(env);
  if (fromEnv) return fromEnv;
  return (await localCollectorListening()) ? "http://127.0.0.1:4318/v1/traces" : undefined;
}
