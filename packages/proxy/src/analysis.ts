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
  /** The window's rows: the failure first, the recovering call last when there was one. */
  rows: LedgerRow[];
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
  /** How many recoveries took that path. */
  topRecoveryPathCount: number;
  topShapeChange: string | undefined;
  /** How many recoveries made that change. */
  topShapeChangeCount: number;
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

/**
 * Error classes only transcript rows carry (`sayagain audit`): the user stopped the call, or the
 * file has no result for it. Neither is a failure of the tool; both leave a write's outcome
 * unknown (M9). The boundary never writes them.
 */
export const UNKNOWN_OUTCOME_CLASSES: ReadonlySet<string> = new Set(["interrupt", "no-result"]);
/** An error row that counts as a failure (M1): everything but an unknown outcome. */
export const isFailure = (r: LedgerRow): boolean =>
  r.isError && !UNKNOWN_OUTCOME_CLASSES.has(r.errorClass ?? "");

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
      if (!isFailure(r) || r.status === "deduplicated" || !inWindow(r, opts.since)) continue;
      let recovered = false;
      let calls = 0;
      let bytes = bytesOf(r);
      const window: LedgerRow[] = [r];
      const path: string[] = [];
      let shapeChange: string | undefined;
      let retried = false;
      let identicalRetry = false;
      for (let j = i + 1; j < stream.length && calls < cap; j++) {
        const n = stream[j] as LedgerRow;
        bytes += bytesOf(n);
        window.push(n);
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
        rows: window,
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
    a.latencies.push(Math.max(0, r.latencyMs - (r.held?.waitedMs ?? 0))); // the operator's wait is not the tool's latency
    if (resolvedByRetry(r)) a.boundary.retried++;
    if (r.status === "repaired") a.boundary.repaired++;
    if (r.held?.decision === "approve") a.boundary.held++;
    if (r.status === "dead-lettered") a.boundary.deadLettered++;
    if (!isFailure(r)) continue;
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
          topRecoveryPathCount: s.paths[top(s.paths) ?? ""] ?? 0,
          topShapeChange: top(s.shapes),
          topShapeChangeCount: s.shapes[top(s.shapes) ?? ""] ?? 0,
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
export const isUnacknowledged = (r: LedgerRow): boolean =>
  isWrite(r) &&
  (r.status === "dead-lettered" ||
    (r.status === "held" && r.held?.mode === "unknown-outcome" && r.held.decision !== "approve") ||
    (r.status !== "held" &&
      r.isError &&
      (r.errorClass === "retryable" || UNKNOWN_OUTCOME_CLASSES.has(r.errorClass ?? ""))));

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
  const failures = outcomes.filter(isFailure);
  const unack = finals.filter(isUnacknowledged);
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
    if (isFailure(r)) {
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
      failureRatePct: pct(previous.outcomes.filter(isFailure).length, previous.outcomes.length),
      deadLettered: previous.outcomes.filter((r) => r.status === "dead-lettered").length,
      failureTaxBytesPer1kCalls: Math.round(
        (1000 * previous.wasteBytes) / previous.outcomes.length,
      ),
    };
  return out;
}

/** One arm of the A/B protocol (docs/measurement.md 5.4), measured with the report's definitions. */
export interface ArmStats {
  arm: "control" | "treatment";
  calls: number;
  /** Distinct sessions (else tasks, else the upstream as a whole) among the counted calls: the clusters behind the per-call intervals. */
  sessions: number;
  writes: number;
  failures: number;
  failureRatePct: number;
  unacknowledged: number;
  unacknowledgedPer1kWrites: number;
  /** Recovery bytes summed over the arm's failures, divided by its calls: the failure tax per call. */
  recoveryBytesPerCall: number;
  recovery: {
    recovered: number;
    retryRatePct: number;
    identicalRetryPct: number;
    medianCalls: number;
  };
  boundary: {
    retried: number;
    repaired: number;
    held: number;
    rejected: number;
    deadLettered: number;
    deduplicated: number;
  };
}

/** A difference between the arms, control minus treatment, with a 95% interval. */
export interface ArmDiff {
  control: number;
  treatment: number;
  delta: number;
  /** 95% interval; null when an arm is too small to estimate one (no calls for a rate, fewer than two for a mean). */
  low: number | null;
  high: number | null;
  /** The interval excludes zero: not a test at a stated alpha, and the three differences are not corrected for one another. */
  distinguishable: boolean;
}

export interface AbReport {
  generatedAt: string;
  window: { since: string; until: string; days: number };
  /** The pre-registered minimum per arm before the numbers are read (docs/measurement.md 5.4). */
  targetCallsPerArm: number;
  /** The pre-registered minimum span: the experiment ends two weeks or the target calls per arm in, whichever is later. */
  minimumDays: number;
  /** The span of the armed rows in the window: the experiment as the ledger saw it. */
  experiment: { first: string | null; last: string | null; days: number };
  /** Rows in the window that carry no arm: calls made outside the experiment, on the same definition as `calls`. */
  outside: number;
  arms: { control: ArmStats; treatment: ArmStats };
  differences: {
    /** Primary, cost: the failure tax in bytes per call. */
    recoveryBytesPerCall: ArmDiff;
    /**
     * The same difference from a seeded percentile bootstrap, which makes no normality assumption.
     * The per-call series is mostly zeros with a long tail, so this is the interval to read
     * (docs/measurement.md 5.4, amendment of 2026-09-06).
     */
    recoveryBytesPerCallRobust: ArmDiff;
    /** Primary, risk: unacknowledged writes per 1,000 writes. */
    unacknowledgedPer1kWrites: ArmDiff;
    /** Secondary: the failure rate in percentage points. */
    failureRatePct: ArmDiff;
  };
  /**
   * The failure tax is a failure rate times what a failure costs. Both factors are steadier than
   * their product, and a change in either says something different about the boundary.
   */
  taxFactors: {
    control: { failureRatePct: number; bytesPerFailure: number };
    treatment: { failureRatePct: number; bytesPerFailure: number };
  };
  /** How fast the arms are filling, and when the smaller one reaches the target at that rate. */
  rate: { perArmPerDay: number | null; daysToTarget: number | null; targetDate: string | null };
  /** What a sample of this size can distinguish, from the variance and rates seen so far. */
  power: {
    /** False while the control arm is too small to estimate a baseline; the figures are then null. */
    estimable: boolean;
    callsPerArm: number;
    /** Smallest difference in bytes per call an interval would exclude zero for, at 80% power. */
    failureTaxBytes: number | null;
    /** Smallest relative cut in the rate detectable at that size, 0 to 1; null if none is. */
    unacknowledgedCut: number | null;
    failureRateCut: number | null;
  };
  verdict: string;
}

const Z = 1.96;

/** Wilson interval for k of n, as a fraction. */
const wilsonFrac = (k: number, n: number): { p: number; low: number; high: number } => {
  if (!n) return { p: 0, low: 0, high: 0 };
  const p = k / n;
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
};

/** Newcombe's hybrid score interval for a difference of proportions (control minus treatment). */
function proportionDiff(k1: number, n1: number, k2: number, n2: number, scale: number): ArmDiff {
  const a = wilsonFrac(Math.min(k1, n1), n1);
  const b = wilsonFrac(Math.min(k2, n2), n2);
  const delta = a.p - b.p;
  const low = delta - Math.sqrt((a.p - a.low) ** 2 + (b.high - b.p) ** 2);
  const high = delta + Math.sqrt((a.high - a.p) ** 2 + (b.p - b.low) ** 2);
  const r = (x: number) => +(scale * x).toFixed(scale >= 1000 ? 1 : 2);
  const estimable = n1 > 0 && n2 > 0;
  // The flag is read off the bounds as printed, so the verdict and the interval never disagree.
  return {
    control: r(a.p),
    treatment: r(b.p),
    delta: r(delta),
    low: estimable ? r(low) : null,
    high: estimable ? r(high) : null,
    distinguishable: estimable && (r(low) > 0 || r(high) < 0),
  };
}

/**
 * Difference of means over per-call series (control minus treatment): a normal interval on Welch's
 * standard error. Fine at the pre-registered sample; anticonservative for a handful of calls.
 */
function meanDiff(a: number[], b: number[]): ArmDiff {
  const stats = (xs: number[]) => {
    const n = xs.length;
    const mean = n ? xs.reduce((s, x) => s + x, 0) / n : 0;
    const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
    return { n, mean, variance };
  };
  const x = stats(a);
  const y = stats(b);
  const delta = x.mean - y.mean;
  const estimable = x.n > 1 && y.n > 1;
  const se = estimable ? Math.sqrt(x.variance / x.n + y.variance / y.n) : 0;
  const low = delta - Z * se;
  const high = delta + Z * se;
  const r = (v: number) => Math.round(v);
  return {
    control: r(x.mean),
    treatment: r(y.mean),
    delta: r(delta),
    low: estimable ? r(low) : null,
    high: estimable ? r(high) : null,
    distinguishable: estimable && (r(low) > 0 || r(high) < 0),
  };
}

/**
 * The pre-registered minimum span, in days. Twelve weeks, not two: at the rate this machine's
 * wrappable servers actually produce, 2,000 calls per arm takes about that long
 * (docs/measurement.md 5.4, amendment of 2026-09-06).
 */
export const AB_MINIMUM_DAYS = 84;

/** z for 80% power, alongside Z for a 95% interval. */
const Z_POWER = 0.8416212;
/** Resamples for the bootstrap interval: enough for a stable 95% percentile, cheap enough to run. */
const BOOTSTRAP = 2000;

/** A small deterministic generator, so the same ledger always produces the same interval. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const meanOf = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/**
 * Percentile bootstrap for a difference of means (control minus treatment). The per-call cost series
 * is mostly zeros with a few very large values, where a normal interval is the wrong shape.
 */
function bootstrapDiff(a: number[], b: number[]): ArmDiff {
  const delta = meanOf(a) - meanOf(b);
  const r = (v: number) => Math.round(v);
  if (a.length < 2 || b.length < 2)
    return {
      control: r(meanOf(a)),
      treatment: r(meanOf(b)),
      delta: r(delta),
      low: null,
      high: null,
      distinguishable: false,
    };
  const rand = seeded(0x5a11a9a1);
  const draws: number[] = [];
  for (let i = 0; i < BOOTSTRAP; i++) {
    let sa = 0;
    for (let j = 0; j < a.length; j++) sa += a[(rand() * a.length) | 0] as number;
    let sb = 0;
    for (let j = 0; j < b.length; j++) sb += b[(rand() * b.length) | 0] as number;
    draws.push(sa / a.length - sb / b.length);
  }
  draws.sort((x, y) => x - y);
  const at = (q: number) =>
    draws[Math.min(draws.length - 1, Math.max(0, Math.round(q * (draws.length - 1))))] as number;
  const low = at(0.025);
  const high = at(0.975);
  return {
    control: r(meanOf(a)),
    treatment: r(meanOf(b)),
    delta: r(delta),
    low: r(low),
    high: r(high),
    distinguishable: r(low) > 0 || r(high) < 0,
  };
}

/** Sample size per arm for a difference of proportions at 95% and 80% power. */
function sizeForProportions(p1: number, p2: number): number {
  if (p1 === p2) return Number.POSITIVE_INFINITY;
  const pbar = (p1 + p2) / 2;
  const a = Z * Math.sqrt(2 * pbar * (1 - pbar));
  const b = Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return (a + b) ** 2 / (p1 - p2) ** 2;
}

/** The smallest relative cut in a rate that a sample of this size could distinguish. */
function detectableCut(p: number, n: number): number | null {
  if (!(p > 0) || !(n > 0)) return null;
  for (let cut = 0.01; cut <= 1.0001; cut += 0.01)
    if (sizeForProportions(p, p * (1 - cut)) <= n) return +cut.toFixed(2);
  return null;
}

/** The A/B protocol's page: both arms with the report's definitions, and the differences with intervals. */
export function abReport(
  allRows: LedgerRow[],
  opts: AnalysisOptions & { since: Date; until?: Date; targetCallsPerArm?: number },
): AbReport {
  const until = opts.until ?? new Date();
  const target = opts.targetCallsPerArm ?? 2000;
  const rows = selectRows(allRows, { ...opts, until });
  const inWin = (r: LedgerRow) => inWindow(r, opts.since);
  // One definition of a counted call for the arms, the outside count and the span: a final row in the window
  // that was neither answered from the cache nor left waiting.
  const counted = (r: LedgerRow) => inWin(r) && r.status !== "deduplicated" && r.status !== "held";
  const countedRows = finalRows(rows).filter(counted);
  const outside = countedRows.filter((r) => r.arm === undefined).length;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const r of countedRows) {
    if (r.arm === undefined) continue;
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at)) continue;
    if (at < first) first = at;
    if (at > last) last = at;
  }
  const experiment =
    first <= last
      ? {
          first: new Date(first).toISOString(),
          last: new Date(last).toISOString(),
          days: +((last - first) / 86_400_000).toFixed(1),
        }
      : { first: null, last: null, days: 0 };
  const series: Record<"control" | "treatment", number[]> = { control: [], treatment: [] };
  const arm = (which: "control" | "treatment"): ArmStats => {
    const own = rows.filter((r) => r.arm === which);
    const rep = report(own, { ...opts, until });
    const finals = finalRows(own).filter((r) => inWin(r) && r.status !== "deduplicated");
    const outcomes = finals.filter((r) => r.status !== "held");
    const byReceipt = new Map(
      recoveries(own, { ...opts, since: opts.since }).map((x) => [x.row.receipt, x.bytes]),
    );
    series[which] = outcomes.map((r) => byReceipt.get(r.receipt) ?? 0);
    const failures = rep.byServer.reduce((a, s) => a + s.failures, 0);
    const bytes = series[which];
    return {
      arm: which,
      calls: rep.calls,
      sessions: streams(outcomes).length,
      writes: rep.writes,
      failures,
      failureRatePct: pct(failures, rep.calls),
      unacknowledged: rep.unacknowledged.count,
      unacknowledgedPer1kWrites: rep.northStar.unacknowledgedWritesPer1kWrites,
      // The mean of the same series the interval is computed on, so the table and the difference agree.
      recoveryBytesPerCall: bytes.length
        ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)
        : 0,
      recovery: {
        recovered: rep.recovery.recovered,
        retryRatePct: rep.recovery.retryRatePct,
        identicalRetryPct: rep.recovery.identicalRetryPct,
        medianCalls: rep.recovery.medianCalls,
      },
      boundary: {
        retried: rep.boundary.retriesResolved,
        repaired: rep.boundary.repairsResolved,
        held: rep.boundary.held.approved,
        rejected: rep.boundary.held.rejected,
        deadLettered: rep.boundary.deadLettered,
        deduplicated: rep.boundary.deduplicated,
      },
    };
  };
  const control = arm("control");
  const treatment = arm("treatment");
  const differences = {
    recoveryBytesPerCall: meanDiff(series.control, series.treatment),
    recoveryBytesPerCallRobust: bootstrapDiff(series.control, series.treatment),
    unacknowledgedPer1kWrites: proportionDiff(
      control.unacknowledged,
      control.writes,
      treatment.unacknowledged,
      treatment.writes,
      1000,
    ),
    failureRatePct: proportionDiff(
      control.failures,
      control.calls,
      treatment.failures,
      treatment.calls,
      100,
    ),
  };
  const factorsOf = (
    a: ArmStats,
    s: number[],
  ): { failureRatePct: number; bytesPerFailure: number } => ({
    failureRatePct: a.failureRatePct,
    bytesPerFailure: a.failures ? Math.round(s.reduce((x, y) => x + y, 0) / a.failures) : 0,
  });
  const taxFactors = {
    control: factorsOf(control, series.control),
    treatment: factorsOf(treatment, series.treatment),
  };

  const smaller = Math.min(control.calls, treatment.calls);
  // Two days of armed traffic before a rate means anything; below that the projection would be noise.
  const perArmPerDay = experiment.days >= 2 ? +(smaller / experiment.days).toFixed(1) : null;
  const daysToTarget =
    perArmPerDay && perArmPerDay > 0
      ? Math.ceil(Math.max(0, target - smaller) / perArmPerDay)
      : null;
  const rate = {
    perArmPerDay,
    daysToTarget,
    targetDate:
      daysToTarget === null
        ? null
        : new Date(until.getTime() + daysToTarget * 86_400_000).toISOString(),
  };

  // What the pre-registered size can distinguish, given the spread and rates seen so far.
  const pooled = [...series.control, ...series.treatment];
  const n = pooled.length;
  const mean = meanOf(pooled);
  const sd = n > 1 ? Math.sqrt(pooled.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const writeShare = control.calls ? control.writes / control.calls : 0;
  // A baseline needs enough of the control arm to be worth quoting; below that the figures would
  // say more about the sample than about the design.
  const POWER_MIN_CALLS = 100;
  const estimable = control.calls >= POWER_MIN_CALLS;
  const power = {
    estimable,
    callsPerArm: target,
    failureTaxBytes:
      estimable && n >= 30 && sd > 0
        ? Math.round((Z + Z_POWER) * sd * Math.sqrt(2 / target))
        : null,
    unacknowledgedCut:
      estimable && control.writes > 0 && control.unacknowledged > 0
        ? detectableCut(control.unacknowledged / control.writes, target * writeShare)
        : null,
    failureRateCut:
      estimable && control.failures > 0
        ? detectableCut(control.failures / control.calls, target)
        : null,
  };

  const shortCalls = Math.max(0, target - Math.min(control.calls, treatment.calls));
  const shortDays = Math.max(0, +(AB_MINIMUM_DAYS - experiment.days).toFixed(1));
  const cost = differences.recoveryBytesPerCallRobust;
  const risk = differences.unacknowledgedPer1kWrites;
  const say = (d: ArmDiff, unit: string) => {
    if (d.low === null || d.high === null) return `not estimable (${d.delta} ${unit})`;
    if (!d.distinguishable)
      return `not distinguishable from zero (${d.delta} ${unit}, 95% ${d.low} to ${d.high})`;
    return d.low > 0
      ? `treatment lowers it by ${Math.abs(d.delta)} ${unit} (95% ${d.low} to ${d.high})`
      : `treatment raises it by ${Math.abs(d.delta)} ${unit} (95% ${d.low} to ${d.high})`;
  };
  const needs = [
    shortCalls ? `${shortCalls} more calls in the smaller arm` : "",
    shortDays ? `${shortDays} more days` : "",
  ].filter(Boolean);
  const minimum = needs.length
    ? `${needs.join(" and ")} before the pre-registered minimum (${AB_MINIMUM_DAYS} days or ${target} calls per arm, whichever is later). `
    : `Both arms passed the pre-registered minimum (${AB_MINIMUM_DAYS} days and ${target} calls per arm). `;
  // Risk first, then cost (ADR-0009 decision 2).
  const verdict = `${minimum}Unacknowledged writes: ${say(risk, "per 1K writes")}. Failure tax per call: ${say(cost, "bytes")}.`;
  const windowMs = until.getTime() - opts.since.getTime();
  return {
    generatedAt: new Date().toISOString(),
    window: {
      since: opts.since.toISOString(),
      until: until.toISOString(),
      days: +(windowMs / 86_400_000).toFixed(1),
    },
    targetCallsPerArm: target,
    minimumDays: AB_MINIMUM_DAYS,
    experiment,
    taxFactors,
    rate,
    power,
    outside,
    arms: { control, treatment },
    differences,
    verdict,
  };
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
