/**
 * The learning loop's first half (ADR-0007): what the ledger says about each
 * tool. Failures are grouped by masked signature, recovery is measured in
 * calls (the wire's stand-in for turns) and bytes (its stand-in for tokens),
 * and tools are ranked by the waste their failures cause per thousand calls.
 * Pure functions over ledger rows; nothing here reads argument values.
 */
import type { LedgerRow } from "./ledger.js";

export interface AnalysisOptions {
  /** Only failures at or after this time count; earlier rows still provide context. */
  since?: Date;
  /** Only rows before this time. */
  until?: Date;
  /** Only this upstream (its own name or its registry name). */
  server?: string;
  /** Tools with fewer calls are not ranked. Default 10. */
  minCalls?: number;
  /** Rows after a failure that count towards recovery. Default 10. */
  recoveryCap?: number;
}

export interface Recovery {
  row: LedgerRow;
  recovered: boolean;
  /** Rows between the failure and the next success of the same tool (capped). */
  calls: number;
  /** Request and response bytes spent in the window, the failure itself included. */
  bytes: number;
  /** Tools called between the failure and the recovery, in order. */
  path: string[];
  /** Argument keys or types that differed between the failing and the recovering call. */
  shapeChange: string | undefined;
  /** The same tool was called again within three calls (M2). */
  retried: boolean;
  /** ...with the same arguments (M3). */
  identicalRetry: boolean;
}

export interface SignatureStats {
  server: string;
  tool: string;
  signature: string;
  errorClass: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  medianCallsToRecover: number;
  unrecovered: number;
  wasteBytes: number;
  topRecoveryPath: string | undefined;
  topShapeChange: string | undefined;
  suggestion: string;
}

export interface ToolStats {
  server: string;
  tool: string;
  toolClass: string;
  calls: number;
  failures: number;
  failureRatePct: number;
  misCallRatePct: number;
  /** Failures followed by the same tool within three calls (M2). */
  retryRatePct: number;
  /** Retries whose arguments were unchanged, as a share of retries (M3). */
  identicalRetryPct: number;
  medianCallsToRecover: number;
  unrecoveredPct: number;
  wasteBytes: number;
  wasteBytesPer1kCalls: number;
  /** What the boundary did: resolved by retry or repair, held, dead-lettered, deduplicated, replayed. */
  boundary: {
    retried: number;
    repaired: number;
    held: number;
    deadLettered: number;
    deduplicated: number;
    replayed: number;
  };
  p50LatencyMs: number;
  p95LatencyMs: number;
  signatures: SignatureStats[];
}

export interface Report {
  generatedAt: string;
  window: { since: string; until: string; days: number };
  calls: number;
  writes: number;
  northStar: {
    /** Recovery bytes per 1,000 calls: the failure tax the wire can see. */
    failureTaxBytesPer1kCalls: number;
    /** Non-read-only calls that ended without a known outcome, per 1,000 writes (M9). */
    unacknowledgedWritesPer1kWrites: number;
  };
  byServer: {
    server: string;
    calls: number;
    failures: number;
    failureRatePct: number;
    addressablePct: number;
    classes: Record<string, number>;
  }[];
  /** Non-read-only calls repeated with the same arguments within five calls (M8), caught by the boundary or not. */
  duplicates: { count: number; per1kWrites: number; tools: { tool: string; count: number }[] };
  unacknowledged: { count: number; tools: { tool: string; count: number }[] };
  recovery: {
    failures: number;
    recovered: number;
    retryRatePct: number;
    identicalRetryPct: number;
    medianCalls: number;
    meanCalls: number;
    medianBytes: number;
    meanBytes: number;
  };
  boundary: {
    retriesResolved: number;
    repairsResolved: number;
    held: { approved: number; rejected: number; undecided: number; cancelled: number };
    deadLettered: number;
    replays: { count: number; succeeded: number };
    deduplicated: number;
    /** Failures the boundary itself produced: upstream exits and timeouts. */
    infrastructure: number;
  };
  topSignatures: SignatureStats[];
  tools: ToolStats[];
  /** The same numbers for the window before this one. */
  previous?: {
    calls: number;
    failureRatePct: number;
    deadLettered: number;
    failureTaxBytesPer1kCalls: number;
  };
}

/** Signatures the boundary writes itself when it abandons a call. */
export const BOUNDARY_SIGNATURE = /^sayagain: /;

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};
const pct = (a: number, b: number): number => (b ? +((100 * a) / b).toFixed(1) : 0);
const mean = (xs: number[]): number =>
  xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0;
const bump = (o: Record<string, number>, k: string, n = 1): void => {
  o[k] = (o[k] ?? 0) + n;
};
const top = (o: Record<string, number>): string | undefined =>
  Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];
const isWrite = (r: LedgerRow): boolean => r.toolClass !== "read-only";
const bytesOf = (r: LedgerRow): number => (r.requestBytes ?? 0) + (r.responseBytes ?? 0);
const sameTool = (a: LedgerRow, b: LedgerRow): boolean =>
  a.upstream === b.upstream && a.tool === b.tool;
const inWindow = (r: LedgerRow, since: Date | undefined): boolean =>
  since === undefined || Date.parse(r.ts) >= since.getTime();

/** Rows for the server (either name) and before `until`, oldest first. Rows before `since` stay: they give context. */
export function selectRows(rows: LedgerRow[], opts: AnalysisOptions = {}): LedgerRow[] {
  const until = opts.until?.getTime() ?? Number.POSITIVE_INFINITY;
  return rows
    .filter(
      (r) =>
        r.method === "tools/call" &&
        (!opts.server || r.upstream === opts.server || r.server === opts.server),
    )
    .filter((r) => Date.parse(r.ts) < until)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The key that orders a host's calls: its session, else its task, else the upstream as a whole. */
const streamOf = (r: LedgerRow): string =>
  r.session !== undefined
    ? `session:${r.session}`
    : r.task !== undefined
      ? `task:${r.task}`
      : `upstream:${r.upstream}`;

/**
 * The last word on each call. Rows for one receipt are written in time order: a failed attempt,
 * then the hold that followed it, then the execution after an approval. The last row wins.
 * Replays are operator actions, not agent calls, and are left out.
 */
export function finalRows(rows: LedgerRow[]): LedgerRow[] {
  const last = new Map<string, LedgerRow>();
  for (const r of rows) if (r.replayOf === undefined) last.set(r.receipt, r);
  return rows.filter((r) => last.get(r.receipt) === r);
}

/** Shape difference between a failing and a recovering call, e.g. "changed limit:string->number". */
export function shapeDiff(a: string[], b: string[]): string | undefined {
  const keyOf = (s: string) => s.split(":")[0] ?? s;
  const typeOf = (s: string) => s.split(":")[1] ?? "";
  const A = new Map(a.map((s) => [keyOf(s), s]));
  const B = new Map(b.map((s) => [keyOf(s), s]));
  const added = [...B.keys()].filter((k) => !A.has(k));
  const removed = [...A.keys()].filter((k) => !B.has(k));
  const changed = [...A.keys()]
    .filter((k) => B.has(k) && A.get(k) !== B.get(k))
    .map((k) => `${k}:${typeOf(A.get(k) ?? "")}->${typeOf(B.get(k) ?? "")}`);
  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.join(",")}`);
  if (removed.length) parts.push(`removed ${removed.join(",")}`);
  if (changed.length) parts.push(`changed ${changed.join(",")}`);
  return parts.length ? parts.join("; ") : undefined;
}

function streams(rows: LedgerRow[]): LedgerRow[][] {
  const out = new Map<string, LedgerRow[]>();
  for (const r of finalRows(rows)) {
    const k = streamOf(r);
    const s = out.get(k);
    if (s) s.push(r);
    else out.set(k, [r]);
  }
  return [...out.values()];
}

/** Recovery windows for every failed final row at or after `since` (earlier rows give context only). */
export function recoveries(rows: LedgerRow[], opts: AnalysisOptions = {}): Recovery[] {
  const cap = opts.recoveryCap ?? 10;
  const out: Recovery[] = [];
  for (const stream of streams(rows)) {
    for (let i = 0; i < stream.length; i++) {
      const r = stream[i] as LedgerRow;
      if (!r.isError || r.status === "deduplicated" || !inWindow(r, opts.since)) continue;
      let recovered = false;
      let calls = 0;
      let bytes = bytesOf(r);
      const path: string[] = [];
      let shapeChange: string | undefined;
      let retried = false;
      let identicalRetry = false;
      for (let j = i + 1; j < stream.length && calls < cap; j++) {
        const n = stream[j] as LedgerRow;
        bytes += bytesOf(n);
        if (sameTool(n, r) && j - i <= 3) {
          retried = true;
          if (n.argsHash === r.argsHash) identicalRetry = true;
        }
        if (sameTool(n, r) && !n.isError) {
          recovered = true;
          shapeChange = shapeDiff(r.argShape, n.argShape);
          break;
        }
        calls++;
        path.push(n.tool);
      }
      out.push({
        row: r,
        recovered,
        calls: recovered ? calls : cap,
        bytes,
        path,
        shapeChange,
        retried,
        identicalRetry,
      });
    }
  }
  return out;
}

/** Non-read-only calls whose tool and arguments repeat within the next five calls of the same stream (M8). */
export function duplicateWrites(rows: LedgerRow[], opts: AnalysisOptions = {}): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const stream of streams(rows)) {
    for (let i = 0; i < stream.length; i++) {
      const r = stream[i] as LedgerRow;
      if (!isWrite(r) || !inWindow(r, opts.since)) continue;
      for (let j = i + 1; j < stream.length && j <= i + 5; j++) {
        const n = stream[j] as LedgerRow;
        if (sameTool(n, r) && n.argsHash === r.argsHash) {
          out.push(n);
          break;
        }
      }
    }
  }
  return out;
}

export function suggestionFor(errorClass: string, signature: string): string {
  if (BOUNDARY_SIGNATURE.test(signature))
    return "boundary-side: the upstream exited or stopped answering; check the server process and its logs";
  if (errorClass === "coercible")
    return "deterministic coercion at the boundary; tighten the schema type in the tool definition";
  if (errorClass === "retryable")
    return "bounded retry with backoff; ask the server for an idempotency key";
  if (errorClass === "blocked") return "permission or auth configuration; not a model problem";
  if (errorClass === "semantic")
    return /not found|no such|does not exist/i.test(signature)
      ? "precondition check: a read-before-write ordering hint in the tool description"
      : "verify-before-call or reroute; add the constraint to the description";
  return "rewrite the error into an actionable message; measure calls to recover";
}

interface SigAcc {
  count: number;
  cls: string;
  first: string;
  last: string;
  turns: number[];
  unrecovered: number;
  waste: number;
  paths: Record<string, number>;
  shapes: Record<string, number>;
}

interface ToolAcc {
  server: string;
  tool: string;
  toolClass: string;
  calls: number;
  failures: number;
  misCalls: number;
  retried: number;
  identical: number;
  turns: number[];
  unrecovered: number;
  waste: number;
  latencies: number[];
  boundary: ToolStats["boundary"];
  sigs: Map<string, SigAcc>;
}

/** Resolved by the boundary's own retry: more than one attempt, and neither a repair nor an operator decision explains it. */
const resolvedByRetry = (r: LedgerRow): boolean =>
  (r.attempts ?? 1) > 1 && !r.isError && !r.repairs?.length && !r.held;

/** Per-tool statistics with their signatures, ranked by waste per 1,000 calls. */
export function toolStats(rows: LedgerRow[], opts: AnalysisOptions = {}): ToolStats[] {
  const minCalls = opts.minCalls ?? 10;
  const cap = opts.recoveryCap ?? 10;
  const finals = finalRows(rows).filter((r) => inWindow(r, opts.since));
  const recByReceipt = new Map(recoveries(rows, opts).map((x) => [x.row.receipt, x]));
  const acc = new Map<string, ToolAcc>();
  const keyOf = (r: LedgerRow) => `${r.upstream} ${r.tool}`;
  const accFor = (r: LedgerRow): ToolAcc => {
    let a = acc.get(keyOf(r));
    if (!a) {
      a = {
        server: r.upstream,
        tool: r.tool,
        toolClass: r.toolClass,
        calls: 0,
        failures: 0,
        misCalls: 0,
        retried: 0,
        identical: 0,
        turns: [],
        unrecovered: 0,
        waste: 0,
        latencies: [],
        boundary: {
          retried: 0,
          repaired: 0,
          held: 0,
          deadLettered: 0,
          deduplicated: 0,
          replayed: 0,
        },
        sigs: new Map(),
      };
      acc.set(keyOf(r), a);
    }
    return a;
  };
  for (const r of rows) {
    if (!inWindow(r, opts.since)) continue;
    if (r.status === "deduplicated") accFor(r).boundary.deduplicated++;
    if (r.replayOf !== undefined) accFor(r).boundary.replayed++;
  }
  for (const r of finals) {
    if (r.status === "deduplicated" || r.status === "held") continue;
    const a = accFor(r);
    a.calls++;
    a.latencies.push(r.latencyMs);
    if (resolvedByRetry(r)) a.boundary.retried++;
    if (r.status === "repaired") a.boundary.repaired++;
    if (r.held?.decision === "approve") a.boundary.held++;
    if (r.status === "dead-lettered") a.boundary.deadLettered++;
    if (!r.isError) continue;
    a.failures++;
    const boundaryMade = BOUNDARY_SIGNATURE.test(r.errorSignature ?? "");
    if (!boundaryMade && (r.errorClass === "coercible" || r.errorClass === "semantic"))
      a.misCalls++;
    const rec = recByReceipt.get(r.receipt);
    if (rec?.retried) a.retried++;
    if (rec?.identicalRetry) a.identical++;
    const turns = rec ? rec.calls : cap;
    a.turns.push(turns);
    if (!rec?.recovered) a.unrecovered++;
    const waste = rec?.bytes ?? bytesOf(r);
    a.waste += waste;
    const sigKey = r.errorSignature ?? "(no message)";
    let s = a.sigs.get(sigKey);
    if (!s) {
      s = {
        count: 0,
        cls: boundaryMade ? "other" : (r.errorClass ?? "other"),
        first: r.ts,
        last: r.ts,
        turns: [],
        unrecovered: 0,
        waste: 0,
        paths: {},
        shapes: {},
      };
      a.sigs.set(sigKey, s);
    }
    s.count++;
    if (r.ts < s.first) s.first = r.ts;
    if (r.ts > s.last) s.last = r.ts;
    s.turns.push(turns);
    s.waste += waste;
    if (!rec?.recovered) s.unrecovered++;
    else {
      bump(s.paths, rec.path.length ? rec.path.slice(0, 5).join(" > ") : "(retry only)");
      if (rec.shapeChange) bump(s.shapes, rec.shapeChange);
    }
  }
  return [...acc.values()]
    .filter((a) => a.calls >= minCalls)
    .map((a) => ({
      server: a.server,
      tool: a.tool,
      toolClass: a.toolClass,
      calls: a.calls,
      failures: a.failures,
      failureRatePct: pct(a.failures, a.calls),
      misCallRatePct: pct(a.misCalls, a.calls),
      retryRatePct: pct(a.retried, a.failures),
      identicalRetryPct: pct(a.identical, a.retried),
      medianCallsToRecover: quantile(a.turns, 0.5),
      unrecoveredPct: pct(a.unrecovered, a.failures),
      wasteBytes: a.waste,
      wasteBytesPer1kCalls: a.calls ? Math.round((1000 * a.waste) / a.calls) : 0,
      boundary: a.boundary,
      p50LatencyMs: quantile(a.latencies, 0.5),
      p95LatencyMs: quantile(a.latencies, 0.95),
      signatures: [...a.sigs.entries()]
        .map(([signature, s]) => ({
          server: a.server,
          tool: a.tool,
          signature,
          errorClass: s.cls,
          count: s.count,
          firstSeen: s.first,
          lastSeen: s.last,
          medianCallsToRecover: quantile(s.turns, 0.5),
          unrecovered: s.unrecovered,
          wasteBytes: s.waste,
          topRecoveryPath: top(s.paths),
          topShapeChange: top(s.shapes),
          suggestion: suggestionFor(s.cls, signature),
        }))
        .sort((x, y) => y.wasteBytes - x.wasteBytes),
    }))
    .sort((x, y) => y.wasteBytesPer1kCalls - x.wasteBytesPer1kCalls || y.failures - x.failures);
}

/** Every signature across tools, most wasteful first. */
export function signatureStats(rows: LedgerRow[], opts: AnalysisOptions = {}): SignatureStats[] {
  return toolStats(rows, { ...opts, minCalls: 1 })
    .flatMap((t) => t.signatures)
    .sort((x, y) => y.wasteBytes - x.wasteBytes || y.count - x.count);
}

/** A write whose outcome nobody acknowledged: dead-lettered, failed with an unknown outcome, or held for that reason and never approved. */
const unacknowledged = (r: LedgerRow): boolean =>
  isWrite(r) &&
  (r.status === "dead-lettered" ||
    (r.status === "held" && r.held?.mode === "unknown-outcome" && r.held.decision !== "approve") ||
    (r.status !== "held" && r.isError && r.errorClass === "retryable"));

function windowNumbers(
  allRows: LedgerRow[],
  opts: AnalysisOptions,
  since: Date,
  until: Date,
): { outcomes: LedgerRow[]; finals: LedgerRow[]; recs: Recovery[]; wasteBytes: number } {
  const rows = selectRows(allRows, { ...opts, until });
  const finals = finalRows(rows).filter((r) => inWindow(r, since) && r.status !== "deduplicated");
  const outcomes = finals.filter((r) => r.status !== "held");
  const recs = recoveries(rows, { ...opts, since });
  return { outcomes, finals, recs, wasteBytes: recs.reduce((a, x) => a + x.bytes, 0) };
}

/** The one page from docs/measurement.md section 6, from ledger rows alone. */
export function report(
  allRows: LedgerRow[],
  opts: AnalysisOptions & { since: Date; until?: Date },
): Report {
  const until = opts.until ?? new Date();
  const windowMs = until.getTime() - opts.since.getTime();
  const rows = selectRows(allRows, { ...opts, until });
  const { outcomes, finals, recs, wasteBytes } = windowNumbers(allRows, opts, opts.since, until);
  const writes = outcomes.filter(isWrite);
  const failures = outcomes.filter((r) => r.isError);
  const unack = finals.filter(unacknowledged);
  const dup = duplicateWrites(rows, { ...opts, since: opts.since });
  const dedup = rows.filter((r) => r.status === "deduplicated" && inWindow(r, opts.since));
  const countBy = (xs: LedgerRow[]) => {
    const o: Record<string, number> = {};
    for (const r of xs) bump(o, `${r.upstream}/${r.tool}`);
    return Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => ({ tool, count }));
  };
  const byServer = new Map<
    string,
    { calls: number; failures: number; classes: Record<string, number> }
  >();
  for (const r of outcomes) {
    let s = byServer.get(r.upstream);
    if (!s) {
      s = { calls: 0, failures: 0, classes: {} };
      byServer.set(r.upstream, s);
    }
    s.calls++;
    if (r.isError) {
      s.failures++;
      bump(s.classes, r.errorClass ?? "other");
    }
  }
  const held = { approved: 0, rejected: 0, undecided: 0, cancelled: 0 };
  for (const r of finals) {
    if (!r.held) continue;
    if (r.status === "held") {
      if (r.held.cancelled) held.cancelled++;
      else if (r.held.decision === "reject") held.rejected++;
      else held.undecided++;
    } else if (r.held.decision === "approve") held.approved++;
  }
  const replays = rows.filter((r) => r.replayOf !== undefined && inWindow(r, opts.since));
  const previous = windowNumbers(
    allRows,
    opts,
    new Date(opts.since.getTime() - windowMs),
    opts.since,
  );
  const out: Report = {
    generatedAt: new Date().toISOString(),
    window: {
      since: opts.since.toISOString(),
      until: until.toISOString(),
      days: +(windowMs / 86_400_000).toFixed(1),
    },
    calls: outcomes.length,
    writes: writes.length,
    northStar: {
      failureTaxBytesPer1kCalls: outcomes.length
        ? Math.round((1000 * wasteBytes) / outcomes.length)
        : 0,
      unacknowledgedWritesPer1kWrites: writes.length
        ? +((1000 * unack.length) / writes.length).toFixed(1)
        : 0,
    },
    byServer: [...byServer.entries()].map(([server, s]) => ({
      server,
      calls: s.calls,
      failures: s.failures,
      failureRatePct: pct(s.failures, s.calls),
      addressablePct: pct(
        (s.classes.retryable ?? 0) + (s.classes.coercible ?? 0) + (s.classes.semantic ?? 0),
        s.failures,
      ),
      classes: s.classes,
    })),
    duplicates: {
      count: dup.length,
      per1kWrites: writes.length ? +((1000 * dup.length) / writes.length).toFixed(1) : 0,
      tools: countBy(dup),
    },
    unacknowledged: { count: unack.length, tools: countBy(unack) },
    recovery: {
      failures: failures.length,
      recovered: recs.filter((x) => x.recovered).length,
      retryRatePct: pct(recs.filter((x) => x.retried).length, recs.length),
      identicalRetryPct: pct(
        recs.filter((x) => x.identicalRetry).length,
        recs.filter((x) => x.retried).length,
      ),
      medianCalls: quantile(
        recs.map((x) => x.calls),
        0.5,
      ),
      meanCalls: mean(recs.map((x) => x.calls)),
      medianBytes: quantile(
        recs.map((x) => x.bytes),
        0.5,
      ),
      meanBytes: mean(recs.map((x) => x.bytes)),
    },
    boundary: {
      retriesResolved: outcomes.filter(resolvedByRetry).length,
      repairsResolved: outcomes.filter((r) => r.status === "repaired").length,
      held,
      deadLettered: outcomes.filter((r) => r.status === "dead-lettered").length,
      replays: { count: replays.length, succeeded: replays.filter((r) => !r.isError).length },
      deduplicated: dedup.length,
      infrastructure: failures.filter((r) => BOUNDARY_SIGNATURE.test(r.errorSignature ?? ""))
        .length,
    },
    topSignatures: signatureStats(rows, { ...opts, since: opts.since }).slice(0, 5),
    tools: toolStats(rows, { ...opts, since: opts.since }),
  };
  if (previous.outcomes.length)
    out.previous = {
      calls: previous.outcomes.length,
      failureRatePct: pct(
        previous.outcomes.filter((r) => r.isError).length,
        previous.outcomes.length,
      ),
      deadLettered: previous.outcomes.filter((r) => r.status === "dead-lettered").length,
      failureTaxBytesPer1kCalls: Math.round(
        (1000 * previous.wasteBytes) / previous.outcomes.length,
      ),
    };
  return out;
}

/** "7d", "24h", "90m", "2w", or an ISO date, into a Date. */
export function parseSince(text: string, now: Date = new Date()): Date {
  const m = text.match(/^(\d+)\s*([mhdw])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit =
      { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] as string).toLowerCase()] ??
      86_400_000;
    return new Date(now.getTime() - n * unit);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t))
    throw new Error(
      `--since expects a duration like 7d, 24h, 90m, or an ISO date; got ${JSON.stringify(text)}`,
    );
  return new Date(t);
}
