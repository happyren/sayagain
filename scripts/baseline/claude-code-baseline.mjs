#!/usr/bin/env node
/**
 * Baseline metrics M1 to M11 from Claude Code session transcripts.
 * See docs/measurement.md for definitions.
 *
 * Privacy: reads ~/.claude/projects locally and emits only tool names,
 * counts, token totals and timing. Argument values, results and prompts are
 * never written out. Argument hashes exist in memory for duplicate detection
 * and are discarded.
 *
 * Usage:
 *   node scripts/baseline/claude-code-baseline.mjs [--dir ~/.claude/projects]
 *        [--since YYYY-MM-DD] [--json out.json] [--top 15]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const DIR = opt("--dir", join(homedir(), ".claude", "projects"));
const SINCE = opt("--since") ? Date.parse(opt("--since")) : 0;
const JSON_OUT = opt("--json");
const TOP = Number(opt("--top", "15"));

// USD per million tokens (input, output). Cache read = 10% of input,
// cache creation = 125% of input. Adjust when list prices change.
const PRICES = [
  ["fable-5", 10, 50],
  ["opus-5", 5, 25],
  ["sonnet-5", 2, 10],
  ["haiku-4-5", 1, 5],
  ["opus-4", 15, 75],
  ["sonnet-4", 3, 15],
];
const priceFor = (model = "") => PRICES.find(([k]) => model.includes(k)) ?? ["default", 5, 25];

const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "ToolSearch",
]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
const READ_VERBS =
  /^(get|list|search|read|find|fetch|query|describe|show|view|check|status|count|lookup|whoami)/i;
const WRITE_VERBS =
  /^(create|update|delete|send|post|write|set|add|remove|edit|push|merge|publish|upload|insert|put|patch|replace|move|rename|execute|run|trigger|cancel|archive|trash)/i;

function toolClass(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (name.startsWith("mcp__")) {
    const tool = name.split("__").slice(2).join("__");
    if (READ_VERBS.test(tool)) return "read";
    if (WRITE_VERBS.test(tool)) return "write";
    return "unknown";
  }
  return "unknown";
}

const serverOf = (name) => (name.startsWith("mcp__") ? name.split("__")[1] : "builtin");

// Error classes, first match wins. Interrupts are excluded from failure counts.
const ERROR_CLASSES = [
  ["interrupt", /interrupted by user|request interrupted|user cancel/i],
  [
    "retryable",
    /timed? ?out|ETIMEDOUT|deadline exceeded|rate limit|too many requests|\b429\b|ECONNRESET|ECONNREFUSED|socket hang up/i,
  ],
  [
    "coercible",
    /InputValidationError|invalid (param|argument|input)|schema|required (param|field|property)|missing required|must be (a|an|of type)|expected .{1,40} (but )?(got|received)|not a valid|unexpected (property|field|key)/i,
  ],
  [
    "blocked",
    /permission|denied|unauthori[sz]ed|forbidden|\b401\b|\b403\b|EACCES|not allowed|requires? (approval|auth)/i,
  ],
  [
    "semantic",
    /not found|no such file|ENOENT|does not exist|\b404\b|old_string|not unique|did not match|no match(es)? found|already exists|conflict|\b409\b|EEXIST|not a git repository|nothing to commit|has no|unknown (tool|command|option)/i,
  ],
];
function classifyError(text) {
  for (const [cls, re] of ERROR_CLASSES) if (re.test(text)) return cls;
  return "other";
}

function resultText(block, top) {
  const parts = [];
  const c = block.content;
  if (typeof c === "string") parts.push(c);
  else if (Array.isArray(c))
    for (const b of c) if (b && typeof b.text === "string") parts.push(b.text);
  if (top && typeof top === "object") {
    for (const k of ["stderr", "error", "message"])
      if (typeof top[k] === "string") parts.push(top[k]);
  }
  return parts.join("\n").slice(0, 4000);
}

const hashArgs = (input) =>
  createHash("sha1")
    .update(JSON.stringify(input ?? null))
    .digest("hex")
    .slice(0, 16);

function* sessionFiles(dir) {
  // Recursive: subagent transcripts live in nested directories under each project.
  const walk = function* (d, project) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) yield* walk(p, project);
      else if (f.endsWith(".jsonl")) yield { project, file: p };
    }
  };
  for (const project of readdirSync(dir)) {
    const p = join(dir, project);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p, project);
  }
}

// ---------- per-session event stream ----------
function parseSession(file) {
  const events = []; // {kind:'assist'|'use'|'result', ...}
  const seenRequest = new Set();
  const pendingUses = new Map(); // tool_use id -> event index
  let lines;
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return events;
  }
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
    const m = e.message;
    if (!m || typeof m !== "object") continue;
    if (e.type === "assistant") {
      const u = m.usage;
      if (u && e.requestId && !seenRequest.has(e.requestId)) {
        seenRequest.add(e.requestId);
        events.push({
          kind: "assist",
          ts,
          model: m.model ?? "",
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreate: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        });
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === "tool_use" && typeof b.name === "string") {
            pendingUses.set(b.id, events.length);
            events.push({
              kind: "use",
              ts,
              id: b.id,
              name: b.name,
              hash: hashArgs(b.input),
              sidechain: !!e.isSidechain,
            });
          }
        }
      }
    } else if (e.type === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "tool_result") {
          const ui = pendingUses.get(b.tool_use_id);
          const use = ui !== undefined ? events[ui] : undefined;
          if (!use) continue;
          pendingUses.delete(b.tool_use_id);
          const text = resultText(b, e.toolUseResult);
          const isError = b.is_error === true;
          const cls = isError ? classifyError(text) : "ok";
          events.push({
            kind: "result",
            ts,
            useIndex: ui,
            name: use.name,
            hash: use.hash,
            isError,
            cls,
            latencyMs: ts - use.ts,
          });
        }
      }
    }
  }
  // tool_use with no result at all: unknown outcome
  for (const [, ui] of pendingUses)
    events.push({
      kind: "result",
      ts: Number.NaN,
      useIndex: ui,
      name: events[ui].name,
      hash: events[ui].hash,
      isError: false,
      cls: "no-result",
      latencyMs: Number.NaN,
    });
  return events;
}

// ---------- metrics ----------
const tally = () => ({
  calls: 0,
  failures: 0,
  interrupts: 0,
  noResult: 0,
  retries: 0,
  identicalRetries: 0,
  classes: {},
  latencies: [],
});
const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n;
};
const pct = (a, b) => (b ? (100 * a) / b : 0);
const quantile = (arr, q) => {
  if (!arr.length) return Number.NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const usd = (ev) => {
  const [, pin, pout] = priceFor(ev.model);
  return (
    (ev.input * pin + ev.cacheRead * pin * 0.1 + ev.cacheCreate * pin * 1.25 + ev.output * pout) /
    1e6
  );
};

const overall = {
  sessions: 0,
  sessionsWithCalls: 0,
  endedOnFailure: 0,
  tokens: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 },
  usd: 0,
  recoveryTokens: 0,
  recoveryUsd: 0,
};
const all = tally();
const mcp = tally();
const byTool = new Map();
const byServer = new Map();
const byProject = new Map();
const recoveryCosts = []; // usd per failure
const recoveryTokensPer = [];
const loops = { identicalRuns: 0, failureRuns: 0 };
const writes = {
  calls: 0,
  duplicates: 0,
  callsNonBash: 0,
  duplicatesNonBash: 0,
  unacknowledged: 0,
  retriedAfterError: 0,
  tools: {},
};
const models = {};

function get(map, key) {
  if (!map.has(key)) map.set(key, tally());
  return map.get(key);
}

for (const { project, file } of sessionFiles(DIR)) {
  if (SINCE && statSync(file).mtimeMs < SINCE) continue;
  const events = parseSession(file);
  overall.sessions++;
  const results = events.map((e, i) => (e.kind === "result" ? i : -1)).filter((i) => i >= 0);
  if (!results.length) continue;
  overall.sessionsWithCalls++;
  const proj = get(byProject, project.replace(/^-Users-[^-]+-projects-?/, "") || project);

  let sessionUsd = 0;
  let sessionTokens = 0;
  for (const e of events) {
    if (e.kind === "assist") {
      overall.tokens.input += e.input;
      overall.tokens.cacheRead += e.cacheRead;
      overall.tokens.cacheCreate += e.cacheCreate;
      overall.tokens.output += e.output;
      const cost = usd(e);
      overall.usd += cost;
      sessionUsd += cost;
      sessionTokens += e.input + e.cacheRead + e.cacheCreate + e.output;
      bump(models, priceFor(e.model)[0]);
    }
  }

  // sequential scan over results
  let prevIdentical = null;
  let identicalRun = 1;
  let failRunTool = null;
  let failRun = 0;
  const recentWrites = []; // last 5 write (name,hash)
  for (let r = 0; r < results.length; r++) {
    const ev = events[results[r]];
    const t = get(byTool, ev.name);
    const s = get(byServer, serverOf(ev.name));
    const isMcp = ev.name.startsWith("mcp__");
    const tallies = isMcp ? [all, mcp, t, s, proj] : [all, t, s, proj];
    const cls = toolClass(ev.name);

    for (const x of tallies) x.calls++;
    if (ev.cls === "no-result") for (const x of tallies) x.noResult++;
    if (Number.isFinite(ev.latencyMs) && ev.latencyMs >= 0) t.latencies.push(ev.latencyMs);

    if (cls === "write") {
      writes.calls++;
      bump(writes.tools, ev.name);
      if (ev.cls === "no-result" || ev.cls === "interrupt" || ev.cls === "retryable")
        writes.unacknowledged++;
      const key = `${ev.name}:${ev.hash}`;
      if (ev.name !== "Bash") writes.callsNonBash++;
      if (recentWrites.includes(key)) {
        writes.duplicates++;
        if (ev.name !== "Bash") writes.duplicatesNonBash++;
      }
      recentWrites.push(key);
      if (recentWrites.length > 5) recentWrites.shift();
    }

    // loops: identical consecutive calls
    const idKey = `${ev.name}:${ev.hash}`;
    if (idKey === prevIdentical) {
      identicalRun++;
      if (identicalRun === 3) loops.identicalRuns++;
    } else {
      identicalRun = 1;
      prevIdentical = idKey;
    }

    if (ev.isError && ev.cls === "interrupt") {
      for (const x of tallies) x.interrupts++;
      continue;
    }
    if (!ev.isError) {
      failRun = 0;
      failRunTool = null;
      continue;
    }

    // a real failure
    for (const x of tallies) {
      x.failures++;
      bump(x.classes, ev.cls);
    }
    if (failRunTool === ev.name) {
      failRun++;
      if (failRun === 3) loops.failureRuns++;
    } else {
      failRunTool = ev.name;
      failRun = 1;
    }

    // retry: same tool within next 3 results
    let retried = false;
    let identical = false;
    for (let k = r + 1; k <= Math.min(r + 3, results.length - 1); k++) {
      const nx = events[results[k]];
      if (nx.name === ev.name) {
        retried = true;
        if (nx.hash === ev.hash) identical = true;
        break;
      }
    }
    if (retried) for (const x of tallies) x.retries++;
    if (identical) for (const x of tallies) x.identicalRetries++;
    if (retried && cls === "write") writes.retriedAfterError++;

    // recovery window: until next success of same tool, cap 10 results
    let endIdx = results[Math.min(r + 10, results.length - 1)];
    for (let k = r + 1; k <= Math.min(r + 10, results.length - 1); k++) {
      const nx = events[results[k]];
      if (nx.name === ev.name && !nx.isError) {
        endIdx = results[k];
        break;
      }
    }
    let winUsd = 0;
    let winTok = 0;
    for (let i = results[r] + 1; i <= endIdx; i++) {
      const e = events[i];
      if (e.kind === "assist") {
        winUsd += usd(e);
        winTok += e.input + e.cacheRead + e.cacheCreate + e.output;
      }
    }
    recoveryCosts.push(winUsd);
    recoveryTokensPer.push(winTok);
    overall.recoveryUsd += winUsd;
    overall.recoveryTokens += winTok;
  }
  const last = events[results[results.length - 1]];
  if (last.isError && last.cls !== "interrupt") overall.endedOnFailure++;
  proj.usd = (proj.usd ?? 0) + sessionUsd;
  proj.tokens = (proj.tokens ?? 0) + sessionTokens;
}

// ---------- report ----------
const fmtClasses = (c) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
const per1k = (n) => (all.calls ? (1000 * n) / all.calls : 0);
const summarize = (t) => ({
  calls: t.calls,
  failures: t.failures,
  failureRatePct: +pct(t.failures, t.calls).toFixed(2),
  retryRatePct: +pct(t.retries, t.failures).toFixed(1),
  identicalRetryPct: +pct(t.identicalRetries, t.failures).toFixed(1),
  interrupts: t.interrupts,
  noResult: t.noResult,
  classes: t.classes,
  latencyP50Ms: t.latencies?.length ? Math.round(quantile(t.latencies, 0.5)) : null,
  latencyP95Ms: t.latencies?.length ? Math.round(quantile(t.latencies, 0.95)) : null,
});
const addressable = (c) => (c.retryable ?? 0) + (c.coercible ?? 0) + (c.semantic ?? 0);
const totalTokens =
  overall.tokens.input +
  overall.tokens.cacheRead +
  overall.tokens.cacheCreate +
  overall.tokens.output;

const report = {
  generatedAt: new Date().toISOString(),
  scope: {
    dir: DIR,
    since: SINCE ? new Date(SINCE).toISOString().slice(0, 10) : null,
    sessions: overall.sessions,
    sessionsWithCalls: overall.sessionsWithCalls,
  },
  models,
  tokens: { ...overall.tokens, total: totalTokens, estimatedUsd: +overall.usd.toFixed(2) },
  M1_failure: { all: summarize(all), mcp: summarize(mcp) },
  M2_M3_retries: {
    retryRatePct: +pct(all.retries, all.failures).toFixed(1),
    identicalRetryPct: +pct(all.identicalRetries, all.failures).toFixed(1),
  },
  M4_loops: {
    identicalRunsPer1k: +per1k(loops.identicalRuns).toFixed(2),
    failureRunsPer1k: +per1k(loops.failureRuns).toFixed(2),
    identicalRuns: loops.identicalRuns,
    failureRuns: loops.failureRuns,
  },
  M5_recoveryCost: {
    failures: recoveryCosts.length,
    medianUsd: +quantile(recoveryCosts, 0.5).toFixed(4),
    meanUsd: recoveryCosts.length ? +(overall.recoveryUsd / recoveryCosts.length).toFixed(4) : null,
    p90Usd: +quantile(recoveryCosts, 0.9).toFixed(4),
    medianTokens: Math.round(quantile(recoveryTokensPer, 0.5)),
    meanTokens: recoveryTokensPer.length
      ? Math.round(overall.recoveryTokens / recoveryTokensPer.length)
      : null,
  },
  M6_failureTax: {
    recoveryUsd: +overall.recoveryUsd.toFixed(2),
    shareOfTokensPct: +pct(overall.recoveryTokens, totalTokens).toFixed(2),
    shareOfUsdPct: +pct(overall.recoveryUsd, overall.usd).toFixed(2),
  },
  M7_addressable: {
    classes: all.classes,
    addressablePct: +pct(addressable(all.classes), all.failures).toFixed(1),
    mcpClasses: mcp.classes,
    mcpAddressablePct: +pct(addressable(mcp.classes), mcp.failures).toFixed(1),
  },
  M8_M9_writes: {
    writeCalls: writes.calls,
    duplicatesPer1kWrites: +(writes.calls ? (1000 * writes.duplicates) / writes.calls : 0).toFixed(
      2,
    ),
    unacknowledgedPer1kWrites: +(
      writes.calls ? (1000 * writes.unacknowledged) / writes.calls : 0
    ).toFixed(2),
    duplicatesPer1kNonBashWrites: +(
      writes.callsNonBash ? (1000 * writes.duplicatesNonBash) / writes.callsNonBash : 0
    ).toFixed(2),
    duplicates: writes.duplicates,
    duplicatesNonBash: writes.duplicatesNonBash,
    nonBashWriteCalls: writes.callsNonBash,
    unacknowledged: writes.unacknowledged,
    retriedAfterError: writes.retriedAfterError,
  },
  M10_endedOnFailure: {
    sessions: overall.endedOnFailure,
    pctOfSessionsWithCalls: +pct(overall.endedOnFailure, overall.sessionsWithCalls).toFixed(1),
  },
  northStar: {
    failureTaxUsdPer1kCalls: +per1k(overall.recoveryUsd).toFixed(2),
    unacknowledgedWritesPer1kCalls: +per1k(writes.unacknowledged).toFixed(2),
  },
  byServer: Object.fromEntries([...byServer].map(([k, v]) => [k, summarize(v)])),
  byTool: Object.fromEntries(
    [...byTool]
      .sort((a, b) => b[1].failures - a[1].failures || b[1].calls - a[1].calls)
      .slice(0, TOP)
      .map(([k, v]) => [k, summarize(v)]),
  ),
  byProject: Object.fromEntries(
    [...byProject]
      .sort((a, b) => b[1].failures - a[1].failures)
      .slice(0, TOP)
      .map(([k, v]) => [k, { ...summarize(v), estimatedUsd: +(v.usd ?? 0).toFixed(2) }]),
  ),
};

if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

const f = (n, d = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })
    : "n/a";
const lines = [];
lines.push(
  `# Baseline from Claude Code transcripts (${report.scope.since ?? "all time"} to ${report.generatedAt.slice(0, 10)})`,
);
lines.push("");
lines.push(
  `Sessions ${f(overall.sessions)} (${f(overall.sessionsWithCalls)} with tool calls). Tool calls ${f(all.calls)}, of which MCP ${f(mcp.calls)}. Tokens ${f(totalTokens)} (API-equivalent $${f(overall.usd, 2)}; cache reads dominate).`,
);
lines.push("");
lines.push("| Metric | All tools | MCP tools |");
lines.push("| --- | ---: | ---: |");
lines.push(
  `| M1 failure rate | ${f(report.M1_failure.all.failureRatePct, 2)}% (${f(all.failures)}) | ${f(report.M1_failure.mcp.failureRatePct, 2)}% (${f(mcp.failures)}) |`,
);
lines.push(
  `| M2 retry rate (of failures) | ${f(report.M1_failure.all.retryRatePct, 1)}% | ${f(report.M1_failure.mcp.retryRatePct, 1)}% |`,
);
lines.push(
  `| M3 identical-retry rate | ${f(report.M1_failure.all.identicalRetryPct, 1)}% | ${f(report.M1_failure.mcp.identicalRetryPct, 1)}% |`,
);
lines.push(
  `| M7 addressable share | ${f(report.M7_addressable.addressablePct, 1)}% | ${f(report.M7_addressable.mcpAddressablePct, 1)}% |`,
);
lines.push(`| Calls with no result | ${f(all.noResult)} | ${f(mcp.noResult)} |`);
lines.push("");
lines.push(
  `M4 loops per 1K calls: identical runs ${f(report.M4_loops.identicalRunsPer1k, 2)}, failure runs ${f(report.M4_loops.failureRunsPer1k, 2)}.`,
);
lines.push(
  `M5 recovery cost per failure: median $${f(report.M5_recoveryCost.medianUsd, 4)}, mean $${f(report.M5_recoveryCost.meanUsd, 4)}, p90 $${f(report.M5_recoveryCost.p90Usd, 4)} (median ${f(report.M5_recoveryCost.medianTokens)} tokens).`,
);
lines.push(
  `M6 failure tax: $${f(report.M6_failureTax.recoveryUsd, 2)} = ${f(report.M6_failureTax.shareOfUsdPct, 1)}% of estimated spend, ${f(report.M6_failureTax.shareOfTokensPct, 1)}% of tokens.`,
);
lines.push(
  `M8/M9 writes: ${f(writes.calls)} write calls (${f(writes.callsNonBash)} excluding Bash); duplicates ${f(report.M8_M9_writes.duplicatesPer1kWrites, 1)} per 1K writes, ${f(report.M8_M9_writes.duplicatesPer1kNonBashWrites, 1)} per 1K excluding Bash; unacknowledged ${f(report.M8_M9_writes.unacknowledgedPer1kWrites, 1)} per 1K writes; write retried after error ${f(writes.retriedAfterError)}.`,
);
lines.push(
  `M10 sessions ended on an unretried failure: ${f(overall.endedOnFailure)} (${f(report.M10_endedOnFailure.pctOfSessionsWithCalls, 1)}%).`,
);
lines.push(
  `North star: failure tax $${f(report.northStar.failureTaxUsdPer1kCalls, 2)} per 1K calls; unacknowledged writes ${f(report.northStar.unacknowledgedWritesPer1kCalls, 2)} per 1K calls.`,
);
lines.push("");
lines.push(
  `Failure classes, all tools: ${fmtClasses(all.classes)}. MCP only: ${fmtClasses(mcp.classes)}. "other" is unclassified, not unaddressable.`,
);
lines.push("");
lines.push("| Tool | Calls | Failures | Rate | Retry | Identical | p50 ms | p95 ms |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [k, v] of Object.entries(report.byTool))
  lines.push(
    `| ${k} | ${f(v.calls)} | ${f(v.failures)} | ${f(v.failureRatePct, 1)}% | ${f(v.retryRatePct, 0)}% | ${f(v.identicalRetryPct, 0)}% | ${f(v.latencyP50Ms)} | ${f(v.latencyP95Ms)} |`,
  );
lines.push("");
lines.push("| Server | Calls | Failures | Rate |");
lines.push("| --- | ---: | ---: | ---: |");
for (const [k, v] of Object.entries(report.byServer).sort((a, b) => b[1].calls - a[1].calls))
  lines.push(`| ${k} | ${f(v.calls)} | ${f(v.failures)} | ${f(v.failureRatePct, 1)}% |`);
lines.push("");
lines.push("| Project | Calls | Failures | Rate | Est. $ |");
lines.push("| --- | ---: | ---: | ---: | ---: |");
for (const [k, v] of Object.entries(report.byProject))
  lines.push(
    `| ${k} | ${f(v.calls)} | ${f(v.failures)} | ${f(v.failureRatePct, 1)}% | ${f(v.estimatedUsd, 2)} |`,
  );
console.log(lines.join("\n"));
