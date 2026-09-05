/**
 * `sayagain audit`: the one page from docs/measurement.md section 6 over transcript history
 * (Phase 0). The 0.6 analysis does the counting; this module adds the cost unit transcripts
 * have and the ledger lacks (tokens priced at list), and renders the page as text and as a
 * static HTML file that is safe to share: names, counts, masked signatures, nothing else.
 */
import {
  report as buildReport,
  finalRows,
  isFailure,
  type Report,
  recoveries,
  selectRows,
} from "./analysis.js";
import type { LedgerRow } from "./ledger.js";
import {
  type RowExtra,
  sessionRows,
  TRANSCRIPT_SOURCES,
  type TranscriptSession,
  type TranscriptSource,
} from "./transcripts.js";

export interface AuditOptions {
  since: Date;
  until?: Date;
  /** Tools with fewer calls are not ranked. Default 10. */
  minCalls?: number;
  /** Tools listed in the health table. Default 15. */
  top?: number;
  version?: string;
}

export interface AuditSource {
  source: TranscriptSource;
  files: number;
  sessions: number;
  calls: number;
  mcpCalls: number;
  tokens: number;
  usd: number;
}

export interface AuditTool {
  server: string;
  tool: string;
  toolClass: string;
  calls: number;
  failures: number;
  failureRatePct: number;
  misCallRatePct: number;
  medianCallsToRecover: number;
  unrecoveredPct: number;
  wasteTokensPer1kCalls: number;
  wasteUsd: number;
  wasteUsdPer1kCalls: number;
  topSignature?: { signature: string; count: number; errorClass: string; suggestion: string };
}

export interface Audit {
  generatedAt: string;
  version: string;
  window: { since: string; until: string; days: number };
  sources: AuditSource[];
  /** The 0.6 report; its byte fields carry tokens. */
  report: Report;
  tokens: number;
  usd: number;
  families: Record<string, number>;
  failureTax: {
    usd: number;
    usdPer1kCalls: number;
    shareOfSpendPct: number;
    shareOfTokensPct: number;
    annualisedUsd: number;
  };
  recoveryCost: {
    failures: number;
    medianUsd: number;
    meanUsd: number;
    p90Usd: number;
    medianTokens: number;
  };
  sessionsEndedOnFailure: { count: number; sessions: number; pct: number };
  classing: { defaultedWrites: number; defaultedBuiltins: number };
  tools: AuditTool[];
  caveats: string[];
}

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};
const pct = (a: number, b: number): number => (b ? +((100 * a) / b).toFixed(1) : 0);
const round = (n: number, d = 2): number => +n.toFixed(d);

export function runAudit(
  sessions: TranscriptSession[],
  opts: AuditOptions,
  files: Partial<Record<TranscriptSource, number>> = {},
): Audit {
  const until = opts.until ?? new Date();
  const since = opts.since;
  const version = opts.version ?? "dev";
  const allRows: LedgerRow[] = [];
  const extras = new Map<string, RowExtra>();
  for (const s of sessions) {
    const { rows, extras: e } = sessionRows(s);
    allRows.push(...rows);
    for (const [k, v] of e) extras.set(k, v);
  }
  const analysis = {
    since,
    until,
    ...(opts.minCalls !== undefined ? { minCalls: opts.minCalls } : {}),
  };
  const rep = buildReport(allRows, analysis);
  const rows = selectRows(allRows, { until });
  const inWindow = (r: LedgerRow) => Date.parse(r.ts) >= since.getTime();
  const outcomes = finalRows(rows).filter(inWindow);
  const extra = (r: LedgerRow): RowExtra | undefined => extras.get(r.receipt);

  const bySource = new Map<TranscriptSource, AuditSource>();
  for (const src of TRANSCRIPT_SOURCES)
    bySource.set(src, {
      source: src,
      files: files[src] ?? 0,
      sessions: 0,
      calls: 0,
      mcpCalls: 0,
      tokens: 0,
      usd: 0,
    });
  const sessionsSeen = new Set<string>();
  const families: Record<string, number> = {};
  let tokens = 0;
  let usd = 0;
  let defaultedWrites = 0;
  let defaultedBuiltins = 0;
  for (const r of outcomes) {
    const x = extra(r);
    if (!x) continue;
    const s = bySource.get(x.source);
    if (s) {
      s.calls++;
      if (x.isMcp) s.mcpCalls++;
      s.tokens += x.tokens;
      s.usd += x.usd;
      if (r.session && !sessionsSeen.has(r.session)) {
        sessionsSeen.add(r.session);
        s.sessions++;
      }
    }
    tokens += x.tokens;
    usd += x.usd;
    families[x.family] = (families[x.family] ?? 0) + 1;
    if (x.classSource === "default") {
      if (x.isMcp) defaultedWrites++;
      else defaultedBuiltins++;
    }
  }

  const recs = recoveries(rows, { since });
  const recUsd = recs.map((x) => x.rows.reduce((a, r) => a + (extra(r)?.usd ?? 0), 0));
  const taxUsd = recUsd.reduce((a, b) => a + b, 0);
  const wasteTokens = recs.reduce((a, x) => a + x.bytes, 0);
  const days = Math.max(rep.window.days, 1 / 24);
  const toolUsd = new Map<string, number>();
  recs.forEach((x, i) => {
    const k = `${x.row.upstream}/${x.row.tool}`;
    toolUsd.set(k, (toolUsd.get(k) ?? 0) + (recUsd[i] ?? 0));
  });

  const bySession = new Map<string, LedgerRow[]>();
  for (const r of outcomes) {
    const k = r.session ?? "";
    const list = bySession.get(k);
    if (list) list.push(r);
    else bySession.set(k, [r]);
  }
  let ended = 0;
  for (const list of bySession.values()) {
    const last = list[list.length - 1];
    if (last && isFailure(last)) ended++;
  }

  const caveats: string[] = [];
  const unrecorded = sessions.filter((s) => !s.resultsRecorded && s.calls.length).length;
  if (unrecorded)
    caveats.push(
      `${unrecorded} session file${unrecorded === 1 ? "" : "s"} carr${unrecorded === 1 ? "ies" : "y"} tool calls but no tool results (Cursor writes them elsewhere); those outcomes are unrecorded and count as calls only.`,
    );
  const cursor = bySource.get("cursor");
  if (cursor?.calls && !cursor.tokens)
    caveats.push("Cursor transcripts carry no token usage, so the cost numbers exclude them.");
  if (defaultedWrites)
    caveats.push(
      `${defaultedWrites} MCP call${defaultedWrites === 1 ? "" : "s"} to tools without a read verb were classed write, as the boundary would without annotations; M8 and M9 include them.`,
    );
  if (defaultedBuiltins)
    caveats.push(
      `${defaultedBuiltins} call${defaultedBuiltins === 1 ? "" : "s"} to host-internal tools (agents, plans, todos) were counted read-only.`,
    );
  if (rep.previous)
    caveats.push(
      "The previous window covers only session files modified since twice the window ago, so its numbers can be partial.",
    );
  caveats.push(
    "Dollar figures are API-equivalent at list prices; a subscription pays differently. Built-in host tools are included; the product claim rests on the MCP subset (docs/measurement.md 5.1).",
  );

  const tools: AuditTool[] = rep.tools.slice(0, opts.top ?? 15).map((t) => {
    const wasteUsd = toolUsd.get(`${t.server}/${t.tool}`) ?? 0;
    const sig = t.signatures[0];
    return {
      server: t.server,
      tool: t.tool,
      toolClass: t.toolClass,
      calls: t.calls,
      failures: t.failures,
      failureRatePct: t.failureRatePct,
      misCallRatePct: t.misCallRatePct,
      medianCallsToRecover: t.medianCallsToRecover,
      unrecoveredPct: t.unrecoveredPct,
      wasteTokensPer1kCalls: t.wasteBytesPer1kCalls,
      wasteUsd: round(wasteUsd, 4),
      wasteUsdPer1kCalls: t.calls ? round((1000 * wasteUsd) / t.calls) : 0,
      ...(sig
        ? {
            topSignature: {
              signature: sig.signature,
              count: sig.count,
              errorClass: sig.errorClass,
              suggestion: sig.suggestion,
            },
          }
        : {}),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    version,
    window: rep.window,
    sources: [...bySource.values()]
      .filter((s) => s.files || s.calls)
      .map((s) => ({ ...s, tokens: Math.round(s.tokens), usd: round(s.usd) })),
    report: rep,
    tokens: Math.round(tokens),
    usd: round(usd),
    families,
    failureTax: {
      usd: round(taxUsd),
      usdPer1kCalls: outcomes.length ? round((1000 * taxUsd) / outcomes.length) : 0,
      shareOfSpendPct: pct(taxUsd, usd),
      shareOfTokensPct: pct(wasteTokens, tokens),
      annualisedUsd: Math.round((taxUsd * 365) / days),
    },
    recoveryCost: {
      failures: recs.length,
      medianUsd: round(quantile(recUsd, 0.5), 4),
      meanUsd: recUsd.length ? round(taxUsd / recUsd.length, 4) : 0,
      p90Usd: round(quantile(recUsd, 0.9), 4),
      medianTokens: Math.round(
        quantile(
          recs.map((x) => x.bytes),
          0.5,
        ),
      ),
    },
    sessionsEndedOnFailure: {
      count: ended,
      sessions: bySession.size,
      pct: pct(ended, bySession.size),
    },
    classing: { defaultedWrites, defaultedBuiltins },
    tools,
    caveats,
  };
}

const f = (n: number, d = 0): string =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })
    : "n/a";
const money = (n: number, d = 2): string => `$${f(n, d)}`;
const tok = (n: number): string =>
  n >= 1e9
    ? `${f(n / 1e9, 1)}B tokens`
    : n >= 1e6
      ? `${f(n / 1e6, 1)}M tokens`
      : n >= 1e3
        ? `${f(n / 1e3, 1)}K tokens`
        : `${f(n)} tokens`;
const when = (iso: string): string => iso.slice(0, 10);
const named = (xs: { tool: string; count: number }[]): string =>
  xs.length ? `  ${xs.map((t) => `${t.tool} ${t.count}`).join(", ")}` : "";

/** The page as text, in the order docs/measurement.md section 6 asks for: risk first. */
export function renderAuditText(a: Audit): string {
  const r = a.report;
  const out: string[] = [];
  const span = a.window.days >= 1 ? `${f(a.window.days)} days` : "under a day";
  const sources = a.sources
    .filter((s) => s.calls)
    .map((s) => `${s.source} ${s.sessions} sessions, ${f(s.calls)} calls (${f(s.mcpCalls)} MCP)`)
    .join("; ");
  out.push(
    `Say Again audit: ${when(a.window.since)} to ${when(a.window.until)} UTC (${span}); ${sources || "no transcripts found"}`,
  );
  const fam = Object.entries(a.families)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${pct(v, r.calls)}%`)
    .join(", ");
  out.push(
    `Spend in window: ${tok(a.tokens)}, ${money(a.usd)} API-equivalent${fam ? ` (${fam})` : ""}`,
  );
  out.push("");
  out.push("North star (risk, then cost)");
  out.push(
    `  unacknowledged     ${r.northStar.unacknowledgedWritesPer1kWrites} writes per 1K writes without a known outcome (${r.unacknowledged.count} of ${r.writes})`,
  );
  out.push(
    `  failure tax        ${money(a.failureTax.usdPer1kCalls)} per 1K calls; ${money(a.failureTax.usd)} in the window = ${a.failureTax.shareOfSpendPct}% of spend, ${a.failureTax.shareOfTokensPct}% of tokens; annualised at this rate ${money(a.failureTax.annualisedUsd, 0)}`,
  );
  out.push("");
  out.push("Failures by server (M1 rate, M7 addressable share)");
  for (const s of r.byServer)
    out.push(
      `  ${s.server.padEnd(20)} ${String(s.calls).padStart(6)} calls  ${String(s.failureRatePct).padStart(5)}% fail  ${String(s.addressablePct).padStart(5)}% addressable  ${Object.entries(
        s.classes,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  if (!r.byServer.length) out.push("  (no calls)");
  out.push("");
  out.push(
    `Duplicates (M8): ${r.duplicates.count} writes repeated with the same arguments, ${r.duplicates.per1kWrites} per 1K writes${named(r.duplicates.tools)}`,
  );
  out.push(`Unacknowledged writes (M9): ${r.unacknowledged.count}${named(r.unacknowledged.tools)}`);
  out.push("");
  out.push(
    `Recovery (M2, M3, M5, M17): ${r.recovery.failures} failures, ${r.recovery.recovered} recovered; retried ${r.recovery.retryRatePct}%, of which identical ${r.recovery.identicalRetryPct}%; median ${r.recovery.medianCalls} calls to recover (mean ${r.recovery.meanCalls}); per failure median ${money(a.recoveryCost.medianUsd, 4)} (mean ${money(a.recoveryCost.meanUsd, 4)}, p90 ${money(a.recoveryCost.p90Usd, 4)}), median ${tok(a.recoveryCost.medianTokens)}`,
  );
  out.push(
    `Sessions ended on a failure (M10): ${a.sessionsEndedOnFailure.count} of ${a.sessionsEndedOnFailure.sessions} (${a.sessionsEndedOnFailure.pct}%)`,
  );
  if (r.previous) {
    const failures = r.byServer.reduce((x, s) => x + s.failures, 0);
    out.push("");
    out.push(
      `What moved vs the previous ${span}: calls ${f(r.previous.calls)} -> ${f(r.calls)}; failure rate ${r.previous.failureRatePct}% -> ${pct(failures, r.calls)}%; recovery tokens per 1K calls ${f(r.previous.failureTaxBytesPer1kCalls)} -> ${f(r.northStar.failureTaxBytesPer1kCalls)}`,
    );
  }
  out.push("");
  out.push(
    "Tools most prone to mis-calls (M18 waste per 1K calls, M17 calls to recover, M19 mis-call rate)",
  );
  if (!a.tools.length) out.push("  (no tool with enough calls)");
  for (const t of a.tools) {
    out.push(
      `  ${`${t.server}/${t.tool}`.padEnd(40)} ${String(t.calls).padStart(6)} calls  ${String(t.failureRatePct).padStart(5)}% fail  ${String(t.misCallRatePct).padStart(5)}% mis-call  median ${t.medianCallsToRecover} to recover, ${t.unrecoveredPct}% unrecovered  ${money(t.wasteUsdPer1kCalls)}/1K calls (${money(t.wasteUsd)})`,
    );
    if (t.topSignature)
      out.push(
        `      x${t.topSignature.count} ${t.topSignature.errorClass}: ${t.topSignature.signature}\n      suggestion: ${t.topSignature.suggestion}`,
      );
  }
  out.push("");
  out.push("Caveats");
  for (const c of a.caveats) out.push(`  - ${c}`);
  out.push("");
  return `${out.join("\n")}\n`;
}

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const CSS = `
:root { --bg: #f6f7f9; --panel: #fff; --line: #e1e4ea; --text: #1a1d24; --muted: #5f6775; --accent: #148a68; --bad: #b83b3b; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --panel: #161a22; --line: #262c38; --text: #e6e8ee; --muted: #9aa3b5; --accent: #5ac8a6; --bad: #f08a8a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 1040px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; } h1 span { color: var(--muted); font-weight: 400; }
h2 { font-size: 15px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
p.lead { color: var(--muted); margin: 0 0 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
.card .big { font-size: 28px; font-weight: 600; margin: 0; }
.card p { margin: 4px 0 0; color: var(--muted); }
.card.risk .big { color: var(--bad); } .card.cost .big { color: var(--accent); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; } td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
ul.caveats { color: var(--muted); padding-left: 18px; } footer { color: var(--muted); margin-top: 24px; font-size: 12px; }
`;

/** A static page for sharing: no scripts, no values, the same numbers as the text. */
export function renderAuditHtml(a: Audit): string {
  const r = a.report;
  const span = a.window.days >= 1 ? `${f(a.window.days)} days` : "under a day";
  const sources = a.sources.filter((s) => s.calls);
  const fam = Object.entries(a.families)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${pct(v, r.calls)}%`)
    .join(", ");
  const failures = r.byServer.reduce((x, s) => x + s.failures, 0);
  const row = (cells: string[], numeric: boolean[] = []) =>
    `<tr>${cells.map((c, i) => `<td${numeric[i] ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`;
  const head = (cells: string[], numeric: boolean[] = []) =>
    `<tr>${cells.map((c, i) => `<th${numeric[i] ? ' class="n"' : ""}>${esc(c)}</th>`).join("")}</tr>`;
  const classes = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  const serverRows =
    r.byServer
      .map((s) =>
        row(
          [
            esc(s.server),
            esc(f(s.calls)),
            `${esc(s.failureRatePct)}%`,
            `${esc(s.addressablePct)}%`,
            esc(classes(s.classes)),
          ],
          [false, true, true, true],
        ),
      )
      .join("\n") || row(["no calls"]);
  const toolRows =
    a.tools
      .map((t) =>
        row(
          [
            `${esc(t.server)}/${esc(t.tool)}`,
            esc(f(t.calls)),
            `${esc(t.failureRatePct)}%`,
            `${esc(t.misCallRatePct)}%`,
            esc(t.medianCallsToRecover),
            `${esc(t.unrecoveredPct)}%`,
            `${esc(money(t.wasteUsdPer1kCalls))} (${esc(money(t.wasteUsd))})`,
            t.topSignature
              ? `<code>x${esc(t.topSignature.count)} ${esc(t.topSignature.errorClass)}: ${esc(t.topSignature.signature)}</code><br>${esc(t.topSignature.suggestion)}`
              : "",
          ],
          [false, true, true, true, true, true, true],
        ),
      )
      .join("\n") || row(["no tool with enough calls"]);
  const moved = r.previous
    ? `<h2>What moved vs the previous ${esc(span)}</h2><p class="lead">calls ${esc(f(r.previous.calls))} to ${esc(f(r.calls))}; failure rate ${esc(r.previous.failureRatePct)}% to ${esc(pct(failures, r.calls))}%; recovery tokens per 1K calls ${esc(f(r.previous.failureTaxBytesPer1kCalls))} to ${esc(f(r.northStar.failureTaxBytesPer1kCalls))}</p>`
    : "";
  const lead = sources.length
    ? sources
        .map(
          (s) =>
            `${esc(s.source)}: ${esc(s.sessions)} sessions, ${esc(f(s.calls))} calls (${esc(f(s.mcpCalls))} MCP)`,
        )
        .join("; ")
    : "no transcripts found";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Say Again audit ${esc(when(a.window.since))} to ${esc(when(a.window.until))}</title><style>${CSS}</style></head>
<body><main>
<h1>Say Again audit <span>${esc(when(a.window.since))} to ${esc(when(a.window.until))} UTC, ${esc(span)}</span></h1>
<p class="lead">${lead}. Spend ${esc(tok(a.tokens))}, ${esc(money(a.usd))} API-equivalent${fam ? ` (${esc(fam)})` : ""}.</p>
<h2>North star, risk first</h2>
<section class="cards">
  <div class="card risk"><h3>unacknowledged writes</h3><p class="big">${esc(r.northStar.unacknowledgedWritesPer1kWrites)}</p><p>per 1K writes without a known outcome (${esc(r.unacknowledged.count)} of ${esc(r.writes)})</p></div>
  <div class="card cost"><h3>failure tax</h3><p class="big">${esc(money(a.failureTax.usdPer1kCalls))}</p><p>per 1K calls; ${esc(money(a.failureTax.usd))} in the window, ${esc(a.failureTax.shareOfSpendPct)}% of spend; annualised ${esc(money(a.failureTax.annualisedUsd, 0))}</p></div>
  <div class="card"><h3>calls</h3><p class="big">${esc(f(r.calls))}</p><p>${esc(f(r.writes))} writes, ${esc(f(failures))} failures (${esc(pct(failures, r.calls))}%)</p></div>
  <div class="card"><h3>recovery</h3><p class="big">${esc(r.recovery.medianCalls)}</p><p>median calls to recover; ${esc(money(a.recoveryCost.medianUsd, 4))} median per failure, ${esc(r.recovery.retryRatePct)}% retried (${esc(r.recovery.identicalRetryPct)}% identical)</p></div>
</section>
<h2>Failures by server (M1, M7)</h2>
<table>${head(["server", "calls", "failure rate", "addressable", "classes"], [false, true, true, true])}
${serverRows}
</table>
<h2>Writes (M8, M9)</h2>
<table>${head(["metric", "count", "tools"], [false, true])}
${row(["duplicates: the same write repeated with the same arguments within five calls", esc(`${r.duplicates.count} (${r.duplicates.per1kWrites} per 1K writes)`), esc(named(r.duplicates.tools).trim())], [false, true])}
${row(["unacknowledged: interrupted, timed out, or no result recorded", esc(String(r.unacknowledged.count)), esc(named(r.unacknowledged.tools).trim())], [false, true])}
${row(["sessions that ended on a failure (M10)", esc(`${a.sessionsEndedOnFailure.count} of ${a.sessionsEndedOnFailure.sessions} (${a.sessionsEndedOnFailure.pct}%)`), ""], [false, true])}
</table>
${moved}
<h2>Tools most prone to mis-calls (M17, M18, M19)</h2>
<table>${head(["tool", "calls", "fail", "mis-call", "median calls to recover", "unrecovered", "waste per 1K calls", "most common failure"], [false, true, true, true, true, true, true])}
${toolRows}
</table>
<h2>Caveats</h2>
<ul class="caveats">${a.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<footer>Generated by <code>sayagain audit</code> ${esc(a.version)} on ${esc(a.generatedAt.slice(0, 16).replace("T", " "))} UTC. Error signatures are masked error text; the page carries tool names, counts and totals, never arguments, results, prompts or paths. Metric definitions: docs/measurement.md.</footer>
</main></body></html>
`;
}
