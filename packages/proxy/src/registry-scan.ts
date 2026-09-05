/**
 * `sayagain lint --registry`: the registry scan of docs/measurement.md 5.5 (M16). Lists the
 * public MCP registry, asks each server that publishes a remote endpoint for its tool list over
 * Streamable HTTP without credentials, grades every tool with @sayagain/lint, and reports the
 * distribution with the rule-set version so the scan is reproducible. Servers that answer with
 * an auth challenge, or not at all, are counted and left alone. Three messages leave per server:
 * initialize, the initialized notification, tools/list. Nothing else, and no credentials.
 */
import {
  type Finding,
  grade,
  lintTool,
  RULE_SET_VERSION,
  type ToolDefinition,
} from "@sayagain/lint";
import { HttpUpstream } from "./upstream-http.js";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

export interface RegistryServer {
  name: string;
  version: string;
  /** The first streamable-http remote, when the server publishes one. */
  url?: string;
  hasPackages: boolean;
  /** The remote declares a required secret header: it will not answer without credentials. */
  needsSecret: boolean;
}

/**
 * ok: listed tools. auth: refused the unauthenticated probe (401, 403, 407, or a declared secret
 * header). refused: answered with a JSON-RPC error. unreachable: no answer, a network error, or
 * a 5xx. not-mcp: answered with something that is not MCP. no-tools: an empty list. skipped:
 * a private or loopback address, never probed.
 */
export type ProbeOutcome =
  | "ok"
  | "auth"
  | "refused"
  | "unreachable"
  | "not-mcp"
  | "no-tools"
  | "skipped";
export const PROBE_OUTCOMES: readonly ProbeOutcome[] = [
  "ok",
  "auth",
  "refused",
  "unreachable",
  "not-mcp",
  "no-tools",
  "skipped",
];

export interface ProbeResult {
  outcome: ProbeOutcome;
  status?: number;
  detail?: string;
  tools: ToolDefinition[];
  ms: number;
}

export interface ScannedTool {
  name: string;
  grade: ReturnType<typeof grade>;
  findings: Finding[];
}

export interface ScannedServer extends RegistryServer {
  outcome: ProbeOutcome;
  status?: number;
  detail?: string;
  ms: number;
  tools: ScannedTool[];
  /** Listed tools whose definition the linter could not read (a null schema, for one). */
  invalidTools: number;
}

export interface RegistryScan {
  generatedAt: string;
  registry: string;
  ruleSet: string;
  /** How the servers were chosen: every listed server, the first N, or a seeded random sample. */
  selection: {
    mode: "all" | "first" | "sample";
    listed: number;
    withRemote: number;
    chosen: number;
    seed?: number;
  };
  outcomes: Record<ProbeOutcome, number>;
  tools: number;
  invalidTools: number;
  grades: Record<"A" | "B" | "C" | "D" | "F", number>;
  /** Share of graded tools with at least one finding under the rule, in percent. */
  findingShares: Record<string, number>;
  /**
   * M16: share of graded tools with a `params/constrained` finding, with a 95% Wilson interval
   * that treats tools as independent (it ignores clustering by server), plus the per-server view.
   */
  m16: {
    pct: number;
    low: number;
    high: number;
    n: number;
    /** Servers that answered, and how many of them list at least one such tool. */
    servers: number;
    serversWithFinding: number;
    /** The median, across servers that answered, of each server's own share. */
    medianServerSharePct: number;
  };
  servers: ScannedServer[];
}

type Fetch = typeof fetch;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

/**
 * Every active server in the registry, latest version per name (`version=latest`, with
 * deprecated and deleted entries left out). Pages until the cursor runs out or `max` names.
 */
export async function listRegistry(
  opts: { fetchImpl?: Fetch; max?: number; url?: string; log?: (line: string) => void } = {},
): Promise<RegistryServer[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url ?? REGISTRY_URL;
  const byName = new Map<string, RegistryServer>();
  let cursor: string | undefined;
  for (let page = 0; page < 5000; page++) {
    const url = `${base}?limit=100&version=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await doFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const body = (await res.json()) as {
      servers?: { server?: Obj; _meta?: Obj }[];
      metadata?: { nextCursor?: string };
    };
    for (const entry of body.servers ?? []) {
      const s = entry.server ?? (entry as Obj);
      const name = typeof s.name === "string" ? s.name : "";
      if (!name) continue;
      const official = obj(obj(entry._meta)?.[OFFICIAL_META]);
      const status = typeof official?.status === "string" ? official.status : "active";
      if (status !== "active") continue;
      const remotes = Array.isArray(s.remotes) ? (s.remotes as Obj[]) : [];
      const remote = remotes.find((r) => r.type === "streamable-http" && typeof r.url === "string");
      const headers = Array.isArray(remote?.headers) ? (remote.headers as Obj[]) : [];
      const server: RegistryServer = {
        name,
        version: typeof s.version === "string" ? s.version : "",
        ...(typeof remote?.url === "string" ? { url: remote.url } : {}),
        hasPackages: Array.isArray(s.packages) && s.packages.length > 0,
        needsSecret: headers.some((h) => h.isRequired === true && h.isSecret === true),
      };
      byName.set(name, server);
    }
    opts.log?.(`registry: page ${page + 1}, ${byName.size} servers`);
    if (opts.max !== undefined && byName.size >= opts.max) break;
    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  return [...byName.values()];
}

/** Addresses a public scan must not probe: loopback, private ranges, link-local, local names. */
export function isPrivateAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0")
    return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // a bare hostname
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) return /^(fc|fd|fe[89ab])/i.test(host) || host === "::";
  return false;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sayagain-registry-scan", version: "0" },
  },
};

/** Thrown from the fetch wrapper when a response cannot carry MCP; surfaces as a JSON-RPC error. */
class NotMcp extends Error {}

const AUTH_WORDS = /unauthori[sz]ed|forbidden|api[ _-]?key|token|credential|sign in|log ?in/i;

/** initialize, then tools/list, without credentials; the outcome says why a server gave nothing. */
export async function probeTools(
  url: string,
  opts: { fetchImpl?: Fetch; timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!opts.allowPrivate && isPrivateAddress(url))
    return { outcome: "skipped", detail: "private or loopback address", tools: [], ms: 0 };
  // One controller for the whole probe: stopping it also aborts a body the server holds open.
  const controller = new AbortController();
  const base = opts.fetchImpl ?? fetch;
  const observed: Fetch = async (input, init) => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const res = await base(input, { ...init, signal });
    const type = res.headers.get("content-type") ?? "";
    const carries = res.status === 202 || res.status === 204 || /json|event-stream/i.test(type);
    if (res.status < 400 && !carries) {
      await res.body?.cancel().catch(() => undefined);
      throw new NotMcp(`not MCP: answered ${type.split(";")[0] || "no content type"}`);
    }
    return res;
  };
  const upstream = new HttpUpstream({
    url,
    headerTimeoutMs: timeoutMs,
    stream: false,
    fetch: observed,
  });
  const waiting = new Map<number, (msg: Obj) => void>();
  let nonRpc: Omit<ProbeResult, "ms"> | undefined;
  upstream.onLine((text) => {
    let msg: Obj | undefined;
    try {
      msg = obj(JSON.parse(text));
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.jsonrpc !== "2.0") {
      // JSON, but not JSON-RPC: a gateway's own answer.
      nonRpc = AUTH_WORDS.test(text.slice(0, 200))
        ? { outcome: "auth", detail: "answered JSON without jsonrpc, about credentials", tools: [] }
        : { outcome: "not-mcp", detail: "answered JSON without jsonrpc", tools: [] };
      for (const resolve of waiting.values()) resolve(msg);
      return;
    }
    if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
  });
  const done = (r: Omit<ProbeResult, "ms">): ProbeResult => {
    controller.abort();
    upstream.stop();
    return { ...r, ms: Date.now() - started };
  };
  const fromError = (message: string): Omit<ProbeResult, "ms"> => {
    if (message.includes("not MCP:"))
      return {
        outcome: "not-mcp",
        detail: message.replace(/^.*not MCP: /, "").slice(0, 120),
        tools: [],
      };
    const code = message.match(/HTTP (\d{3})/);
    const status = code ? Number(code[1]) : undefined;
    if (status === 401 || status === 403 || status === 407)
      return { outcome: "auth", status, tools: [] };
    if (status !== undefined && status >= 400 && status < 500)
      return { outcome: "not-mcp", status, detail: message.slice(0, 120), tools: [] };
    return {
      outcome: "unreachable",
      ...(status ? { status } : {}),
      detail: message.slice(0, 120),
      tools: [],
    };
  };
  type Answer = { answer: Obj } | { failed: ProbeResult };
  /**
   * Send a request and wait for its answer. The POST itself may not finish before the answer
   * (an SSE body a server holds open), so the answer, the clock and the POST race; HTTP failures
   * and timeouts become outcomes.
   */
  const request = async (line: string, id: number): Promise<Answer> => {
    const answer = new Promise<Obj>((resolve) => waiting.set(id, resolve));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const posted = upstream.sendAndWait(line).then(
      () => "posted" as const,
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    );
    let msg = await Promise.race([answer, late, posted]);
    if (msg === "posted") msg = await Promise.race([answer, late]); // a 202, or a body without the answer
    clearTimeout(timer);
    waiting.delete(id);
    if (nonRpc) return { failed: done(nonRpc) };
    if (msg === "timeout")
      return { failed: done({ outcome: "unreachable", detail: "no answer in time", tools: [] }) };
    if ("error" in msg && typeof msg.error === "string" && !("jsonrpc" in msg))
      return { failed: done(fromError(msg.error)) };
    const err = obj(msg.error);
    if (err) {
      const m = typeof err.message === "string" ? err.message : "";
      const prefix = "upstream unreachable: ";
      if (m.startsWith(prefix)) return { failed: done(fromError(m.slice(prefix.length))) };
      return { failed: done({ outcome: "refused", detail: m.slice(0, 120), tools: [] }) };
    }
    return { answer: msg };
  };
  try {
    const init = await request(JSON.stringify(INITIALIZE), 1);
    if ("failed" in init) return init.failed;
    const result = obj(init.answer.result);
    if (typeof result?.protocolVersion !== "string")
      return done({
        outcome: "not-mcp",
        detail: "initialize answered without a protocol version",
        tools: [],
      });
    // The notification must land before tools/list on a stateful server; wait for the POST,
    // but not past the clock.
    await Promise.race([
      upstream
        .sendAndWait(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 2000)).unref()),
    ]);
    const list = await request(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 2);
    if ("failed" in list) return list.failed;
    const tools = obj(list.answer.result)?.tools;
    if (!Array.isArray(tools) || !tools.length) return done({ outcome: "no-tools", tools: [] });
    const defs = tools.filter(
      (t): t is ToolDefinition =>
        typeof (t as { name?: unknown })?.name === "string" &&
        obj((t as { inputSchema?: unknown }).inputSchema) !== undefined,
    );
    return done({ outcome: defs.length ? "ok" : "not-mcp", tools: defs });
  } catch (err) {
    return done({
      outcome: "unreachable",
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      tools: [],
    });
  }
}

/** A seeded shuffle, so a sample can be repeated. */
function shuffle<T>(xs: T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Wilson score interval for a share, in percent. */
export function wilson(k: number, n: number): { pct: number; low: number; high: number } {
  if (!n) return { pct: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = (x: number) => +(100 * x).toFixed(1);
  return { pct: r(p), low: r(Math.max(0, centre - half)), high: r(Math.min(1, centre + half)) };
}

/** Grade what the linter can read; a definition it cannot is counted, not graded. */
export function gradeTools(tools: ToolDefinition[]): { graded: ScannedTool[]; invalid: number } {
  const graded: ScannedTool[] = [];
  let invalid = 0;
  for (const t of tools) {
    try {
      const findings = lintTool(t);
      graded.push({ name: t.name, grade: grade(findings), findings });
    } catch {
      invalid++;
    }
  }
  return { graded, invalid };
}

export interface ScanOptions {
  fetchImpl?: Fetch;
  /** Probe only the first N servers with a remote. */
  first?: number;
  /** Probe a seeded random sample of N servers with a remote. */
  sample?: number;
  seed?: number;
  concurrency?: number;
  timeoutMs?: number;
  registryUrl?: string;
  /** Probe private and loopback addresses too: for a registry under test, never for the public one. */
  allowPrivate?: boolean;
  log?: (line: string) => void;
}

export async function scanRegistry(opts: ScanOptions = {}): Promise<RegistryScan> {
  const listed = await listRegistry({
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.registryUrl ? { url: opts.registryUrl } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const withRemote = listed.filter(
    (s): s is RegistryServer & { url: string } => s.url !== undefined,
  );
  let chosen = withRemote;
  let mode: RegistryScan["selection"]["mode"] = "all";
  const seed = opts.seed ?? 20260905;
  if (opts.sample !== undefined) {
    mode = "sample";
    chosen = shuffle(withRemote, seed).slice(0, opts.sample);
  } else if (opts.first !== undefined) {
    mode = "first";
    chosen = withRemote.slice(0, opts.first);
  }
  const results: ScannedServer[] = new Array(chosen.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const s = chosen[i];
      if (!s) return;
      const probe: ProbeResult = s.needsSecret
        ? { outcome: "auth", detail: "declares a required secret header", tools: [], ms: 0 }
        : await probeTools(s.url, {
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.allowPrivate ? { allowPrivate: true } : {}),
          });
      const { graded, invalid } = gradeTools(probe.tools);
      results[i] = {
        ...s,
        outcome: probe.outcome,
        ...(probe.status !== undefined ? { status: probe.status } : {}),
        ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
        ms: probe.ms,
        tools: graded,
        invalidTools: invalid,
      };
      opts.log?.(
        `${i + 1}/${chosen.length} ${s.name}: ${probe.outcome} (${graded.length} tools, ${probe.ms} ms)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  return summarizeScan(
    results,
    {
      mode,
      listed: listed.length,
      withRemote: withRemote.length,
      chosen: chosen.length,
      ...(mode === "sample" ? { seed } : {}),
    },
    opts.registryUrl ?? REGISTRY_URL,
  );
}

/** The aggregates from per-server results, so a saved `--out` file can be rendered again. */
export function summarizeScan(
  results: ScannedServer[],
  selection: RegistryScan["selection"],
  registry: string = REGISTRY_URL,
): RegistryScan {
  const outcomes = Object.fromEntries(PROBE_OUTCOMES.map((k) => [k, 0])) as Record<
    ProbeOutcome,
    number
  >;
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const byRule: Record<string, number> = {};
  let tools = 0;
  let invalidTools = 0;
  let unconstrained = 0;
  const serverShares: number[] = [];
  for (const r of results) {
    outcomes[r.outcome]++;
    invalidTools += r.invalidTools ?? 0;
    let own = 0;
    for (const t of r.tools) {
      tools++;
      grades[t.grade]++;
      const rules = new Set(t.findings.map((f) => f.rule));
      for (const rule of rules) byRule[rule] = (byRule[rule] ?? 0) + 1;
      if (rules.has("params/constrained")) {
        unconstrained++;
        own++;
      }
    }
    if (r.outcome === "ok" && r.tools.length) serverShares.push((100 * own) / r.tools.length);
  }
  const sortedShares = [...serverShares].sort((a, b) => a - b);
  const medianServerSharePct = sortedShares.length
    ? +(sortedShares[Math.floor((sortedShares.length - 1) / 2)] as number).toFixed(1)
    : 0;
  const findingShares: Record<string, number> = {};
  for (const [rule, n] of Object.entries(byRule).sort())
    findingShares[rule] = tools ? +((100 * n) / tools).toFixed(1) : 0;
  return {
    generatedAt: new Date().toISOString(),
    registry,
    ruleSet: RULE_SET_VERSION,
    selection,
    outcomes,
    tools,
    invalidTools,
    grades,
    findingShares,
    m16: {
      ...wilson(unconstrained, tools),
      n: tools,
      servers: serverShares.length,
      serversWithFinding: serverShares.filter((x) => x > 0).length,
      medianServerSharePct,
    },
    servers: results,
  };
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");

/** The scan as a page: aggregates only, no server named. */
export function renderRegistryScan(s: RegistryScan): string {
  const out: string[] = [];
  const sel = s.selection;
  out.push(`Registry scan: ${s.generatedAt.slice(0, 10)}, rule set ${s.ruleSet}, ${s.registry}`);
  out.push(
    `Servers listed ${sel.listed} (active, latest version each), with a Streamable HTTP remote ${sel.withRemote}, probed ${sel.chosen}${sel.mode === "sample" ? ` (random sample, seed ${sel.seed})` : sel.mode === "first" ? " (the first listed)" : ""}`,
  );
  out.push("");
  out.push("Probe outcomes (no credentials sent)");
  for (const k of PROBE_OUTCOMES)
    out.push(
      `  ${k.padEnd(12)} ${String(s.outcomes[k]).padStart(6)}  ${pct(s.outcomes[k], sel.chosen)}`,
    );
  out.push("");
  out.push(
    `Tools graded: ${s.tools} from ${s.outcomes.ok} servers${s.invalidTools ? ` (${s.invalidTools} listed definitions the linter could not read)` : ""}`,
  );
  out.push(
    `  grades       ${(["A", "B", "C", "D", "F"] as const).map((g) => `${g} ${s.grades[g]} (${pct(s.grades[g], s.tools)})`).join("  ")}`,
  );
  out.push("");
  out.push(
    `M16, tools without documented parameter constraints: ${s.m16.pct}% (95% interval ${s.m16.low} to ${s.m16.high}, n = ${s.m16.n} tools)`,
  );
  out.push(
    `  per server: ${s.m16.serversWithFinding} of ${s.m16.servers} servers list at least one such tool; median share within a server ${s.m16.medianServerSharePct}%`,
  );
  out.push(
    "  coverage: only servers with a Streamable HTTP remote were probed, without credentials; package-only and SSE-only servers are listed, not probed.",
  );
  out.push(
    "  the interval treats tools as independent and ignores that they cluster by server; the denominator is every tool a server that answered listed, parameterless tools included",
  );
  out.push("Share of tools with a finding, per rule");
  for (const [rule, share] of Object.entries(s.findingShares))
    out.push(`  ${rule.padEnd(28)} ${String(share).padStart(5)}%`);
  out.push("");
  return `${out.join("\n")}\n`;
}
