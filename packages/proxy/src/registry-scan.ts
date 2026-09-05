/**
 * `sayagain lint --registry`: the registry scan of docs/measurement.md 5.5 (M16). Lists the
 * public MCP registry, asks each server that publishes a remote endpoint for its tool list over
 * Streamable HTTP without credentials, grades every tool with @sayagain/lint, and reports the
 * distribution with the rule-set version so the scan is reproducible. Servers that answer with
 * an auth challenge, or not at all, are counted and left alone.
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
}

export type ProbeOutcome = "ok" | "auth" | "unreachable" | "not-mcp" | "no-tools";

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
  grades: Record<"A" | "B" | "C" | "D" | "F", number>;
  /** Share of graded tools with at least one finding under the rule, in percent. */
  findingShares: Record<string, number>;
  /** M16: share of graded tools without documented parameter constraints, with a 95% interval. */
  m16: { pct: number; low: number; high: number; n: number };
  servers: ScannedServer[];
}

type Fetch = typeof fetch;

/** Every server in the registry, latest version per name. Pages until the cursor runs out or `max` names. */
export async function listRegistry(
  opts: { fetchImpl?: Fetch; max?: number; url?: string; log?: (line: string) => void } = {},
): Promise<RegistryServer[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url ?? REGISTRY_URL;
  const byName = new Map<string, RegistryServer>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const url = `${base}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await doFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const body = (await res.json()) as {
      servers?: { server?: Record<string, unknown> }[];
      metadata?: { nextCursor?: string };
    };
    for (const entry of body.servers ?? []) {
      const s = entry.server ?? (entry as Record<string, unknown>);
      const name = typeof s.name === "string" ? s.name : "";
      if (!name) continue;
      const remotes = Array.isArray(s.remotes)
        ? (s.remotes as { type?: string; url?: string }[])
        : [];
      const remote = remotes.find((r) => r.type === "streamable-http" && typeof r.url === "string");
      const server: RegistryServer = {
        name,
        version: typeof s.version === "string" ? s.version : "",
        ...(remote?.url ? { url: remote.url } : {}),
        hasPackages: Array.isArray(s.packages) && s.packages.length > 0,
      };
      byName.set(name, server); // pages list versions oldest first; the last one wins
    }
    opts.log?.(`registry: page ${page + 1}, ${byName.size} servers`);
    if (opts.max !== undefined && byName.size >= opts.max) break;
    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  return [...byName.values()];
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

/** initialize, then tools/list, without credentials; the outcome says why a server gave nothing. */
export async function probeTools(
  url: string,
  opts: { fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // Remember what the last response looked like: a 200 with an HTML body is a web page, not an
  // MCP server, and never yields a JSON-RPC answer to wait for.
  let last: { status: number; type: string } | undefined;
  const base = opts.fetchImpl ?? fetch;
  const observed: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    last = { status: res.status, type: res.headers.get("content-type") ?? "" };
    return res;
  };
  const upstream = new HttpUpstream({
    url,
    headerTimeoutMs: timeoutMs,
    stream: false,
    fetch: observed,
  });
  const done = (r: Omit<ProbeResult, "ms">): ProbeResult => {
    upstream.stop();
    return { ...r, ms: Date.now() - started };
  };
  const request = (line: string, id: number): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer in time")), timeoutMs);
      upstream.onLine((text) => {
        try {
          const msg = JSON.parse(text) as Record<string, unknown>;
          if (msg.id === id) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {
          // not for us
        }
      });
      upstream.send(line);
    });
  const classify = (msg: Record<string, unknown>): ProbeResult | undefined => {
    const err = msg.error as { message?: string } | undefined;
    if (!err) return undefined;
    const m = err.message ?? "";
    const code = m.match(/HTTP (\d{3})/);
    const status = code ? Number(code[1]) : undefined;
    if (status === 401 || status === 403 || status === 407)
      return done({ outcome: "auth", status, tools: [] });
    if (status !== undefined && status >= 400 && status < 500)
      return done({ outcome: "not-mcp", status, detail: m.slice(0, 120), tools: [] });
    return done({
      outcome: "unreachable",
      ...(status ? { status } : {}),
      detail: m.slice(0, 120),
      tools: [],
    });
  };
  try {
    const init = await request(JSON.stringify(INITIALIZE), 1);
    const failed = classify(init);
    if (failed) return failed;
    const result = init.result as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result.protocolVersion !== "string")
      return done({
        outcome: "not-mcp",
        detail: "initialize answered without a protocol version",
        tools: [],
      });
    upstream.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const list = await request(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 2);
    const listFailed = classify(list);
    if (listFailed) return listFailed;
    const tools = (list.result as { tools?: unknown[] } | undefined)?.tools;
    if (!Array.isArray(tools) || !tools.length) return done({ outcome: "no-tools", tools: [] });
    const defs = tools.filter(
      (t): t is ToolDefinition =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { name?: unknown }).name === "string" &&
        typeof (t as { inputSchema?: unknown }).inputSchema === "object",
    );
    return done({ outcome: defs.length ? "ok" : "not-mcp", tools: defs });
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    if (last && last.status < 400 && !/json|event-stream/i.test(last.type))
      return done({
        outcome: "not-mcp",
        status: last.status,
        detail: `answered ${last.type.split(";")[0] || "no content type"}`,
        tools: [],
      });
    return done({ outcome: "unreachable", detail, tools: [] });
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
  log?: (line: string) => void;
}

export async function scanRegistry(opts: ScanOptions = {}): Promise<RegistryScan> {
  const listed = await listRegistry({
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.registryUrl ? { url: opts.registryUrl } : {}),
    ...(opts.first !== undefined && opts.sample === undefined ? { max: opts.first * 3 } : {}),
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
      const probe = await probeTools(s.url, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      results[i] = {
        ...s,
        outcome: probe.outcome,
        ...(probe.status !== undefined ? { status: probe.status } : {}),
        ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
        ms: probe.ms,
        tools: probe.tools.map((t) => {
          const findings = lintTool(t);
          return { name: t.name, grade: grade(findings), findings };
        }),
      };
      opts.log?.(
        `${i + 1}/${chosen.length} ${s.name}: ${probe.outcome} (${probe.tools.length} tools, ${probe.ms} ms)`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  const outcomes: Record<ProbeOutcome, number> = {
    ok: 0,
    auth: 0,
    unreachable: 0,
    "not-mcp": 0,
    "no-tools": 0,
  };
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const byRule: Record<string, number> = {};
  let tools = 0;
  let unconstrained = 0;
  for (const r of results) {
    outcomes[r.outcome]++;
    for (const t of r.tools) {
      tools++;
      grades[t.grade]++;
      const rules = new Set(t.findings.map((f) => f.rule));
      for (const rule of rules) byRule[rule] = (byRule[rule] ?? 0) + 1;
      if (rules.has("params/constrained")) unconstrained++;
    }
  }
  const findingShares: Record<string, number> = {};
  for (const [rule, n] of Object.entries(byRule).sort())
    findingShares[rule] = tools ? +((100 * n) / tools).toFixed(1) : 0;
  return {
    generatedAt: new Date().toISOString(),
    registry: opts.registryUrl ?? REGISTRY_URL,
    ruleSet: RULE_SET_VERSION,
    selection: {
      mode,
      listed: listed.length,
      withRemote: withRemote.length,
      chosen: chosen.length,
      ...(mode === "sample" ? { seed } : {}),
    },
    outcomes,
    tools,
    grades,
    findingShares,
    m16: { ...wilson(unconstrained, tools), n: tools },
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
    `Servers listed ${sel.listed}, with a Streamable HTTP remote ${sel.withRemote}, probed ${sel.chosen}${sel.mode === "sample" ? ` (random sample, seed ${sel.seed})` : sel.mode === "first" ? " (the first listed)" : ""}`,
  );
  out.push("");
  out.push("Probe outcomes (no credentials sent)");
  for (const k of ["ok", "auth", "unreachable", "not-mcp", "no-tools"] as const)
    out.push(
      `  ${k.padEnd(12)} ${String(s.outcomes[k]).padStart(6)}  ${pct(s.outcomes[k], sel.chosen)}`,
    );
  out.push("");
  out.push(`Tools graded: ${s.tools} from ${s.outcomes.ok} servers`);
  out.push(
    `  grades       ${(["A", "B", "C", "D", "F"] as const).map((g) => `${g} ${s.grades[g]} (${pct(s.grades[g], s.tools)})`).join("  ")}`,
  );
  out.push("");
  out.push(
    `M16, tools without documented parameter constraints: ${s.m16.pct}% (95% interval ${s.m16.low} to ${s.m16.high}, n = ${s.m16.n})`,
  );
  out.push("Share of tools with a finding, per rule");
  for (const [rule, share] of Object.entries(s.findingShares))
    out.push(`  ${rule.padEnd(28)} ${String(share).padStart(5)}%`);
  out.push("");
  return `${out.join("\n")}\n`;
}
