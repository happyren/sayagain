import { describe, expect, it } from "vitest";
import {
  abReport,
  duplicateWrites,
  finalRows,
  parseSince,
  recoveries,
  report,
  shapeDiff,
  signatureStats,
  toolStats,
} from "./analysis.js";
import type { LedgerRow } from "./ledger.js";

let seq = 0;
const t0 = Date.parse("2026-09-01T00:00:00Z");
const row = (over: Partial<LedgerRow> & { tool: string; at: number }): LedgerRow => {
  const { at, ...rest } = over;
  seq++;
  return {
    receipt: `r${seq}`,
    ts: new Date(t0 + at * 1000).toISOString(),
    upstream: "notion",
    method: "tools/call",
    toolClass: "read-only",
    argShape: ["id:string"],
    argsHash: "h1",
    hasIntent: false,
    status: "executed",
    isError: false,
    latencyMs: 10,
    requestBytes: 100,
    responseBytes: 200,
    session: "s1",
    ...rest,
  };
};

const fail = (tool: string, at: number, extra: Partial<LedgerRow> = {}): LedgerRow =>
  row({
    tool,
    at,
    isError: true,
    errorClass: "coercible",
    errorSignature: "Invalid params: limit must be a number",
    ...extra,
  });

describe("analysis", () => {
  it("measures recovery in calls and bytes, notices identical retries, and records path and shape change", () => {
    const rows = [
      fail("create_page", 1, { argShape: ["limit:string"], argsHash: "a" }),
      row({
        tool: "create_page",
        at: 2,
        argsHash: "a",
        isError: true,
        argShape: ["limit:string"],
        errorClass: "coercible",
        errorSignature: "x",
      }),
      row({ tool: "get_page", at: 3 }),
      row({ tool: "create_page", at: 4, argShape: ["limit:number"], argsHash: "b" }),
      fail("delete_page", 5, { toolClass: "destructive" }),
    ];
    const recs = recoveries(rows);
    expect(recs).toHaveLength(3);
    const first = recs[0];
    expect(first).toMatchObject({
      recovered: true,
      calls: 2,
      retried: true,
      identicalRetry: true,
      path: ["create_page", "get_page"],
      shapeChange: "changed limit:string->number",
    });
    expect(first?.bytes).toBe(300 * 4);
    expect(recs[2]).toMatchObject({
      recovered: false,
      calls: 10,
      retried: false,
      identicalRetry: false,
    });
  });

  it("ranks tools by waste per 1K calls and groups signatures with suggestions", () => {
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(row({ tool: "search", at: i }));
    for (let i = 0; i < 10; i++)
      rows.push(
        i % 2 === 0
          ? fail("create_page", 20 + i, { toolClass: "write" })
          : row({ tool: "create_page", at: 20 + i, toolClass: "write" }),
      );
    rows.push(
      row({
        tool: "rare",
        at: 40,
        isError: true,
        errorClass: "semantic",
        errorSignature: "page not found",
      }),
    );
    const stats = toolStats(rows, { minCalls: 10 });
    expect(stats.map((t) => t.tool)).toEqual(["create_page", "search"]);
    const cp = stats[0];
    expect(cp).toMatchObject({
      calls: 10,
      failures: 5,
      failureRatePct: 50,
      misCallRatePct: 50,
      unrecoveredPct: 0,
    });
    expect(cp?.wasteBytesPer1kCalls).toBeGreaterThan(0);
    expect(cp?.signatures[0]).toMatchObject({
      count: 5,
      errorClass: "coercible",
      suggestion: expect.stringContaining("coercion"),
    });
    const sigs = signatureStats(rows);
    expect(sigs.map((s) => s.tool)).toEqual(["create_page", "rare"]);
    expect(sigs[1]?.suggestion).toContain("read-before-write");
  });

  it("treats a held-then-approved call as one outcome, counts boundary actions, and finds duplicate writes", () => {
    const held: LedgerRow = row({
      tool: "delete_page",
      at: 1,
      toolClass: "destructive",
      status: "held",
      held: { reason: "r", mode: "pre" },
      argsHash: "d1",
    });
    const executed: LedgerRow = {
      ...row({
        tool: "delete_page",
        at: 2,
        toolClass: "destructive",
        held: { reason: "r", mode: "pre", decision: "approve" },
        argsHash: "d1",
      }),
      receipt: held.receipt,
    };
    const rejected = row({
      tool: "delete_page",
      at: 3,
      toolClass: "destructive",
      status: "held",
      held: { reason: "r", mode: "pre", decision: "reject" },
      argsHash: "d2",
    });
    const retried = row({ tool: "flaky", at: 4, attempts: 3, argsHash: "f1" });
    const repaired = row({
      tool: "strict",
      at: 5,
      status: "repaired",
      attempts: 2,
      repairs: [{ path: "limit", rule: "string-to-number" }],
      argsHash: "s1",
    });
    const dead = row({
      tool: "write_flaky",
      at: 6,
      toolClass: "write",
      status: "dead-lettered",
      isError: true,
      errorClass: "retryable",
      errorSignature: "sayagain: upstream exited before answering",
      argsHash: "w1",
    });
    const first = row({ tool: "create_page", at: 7, toolClass: "write", argsHash: "c1" });
    const again = row({ tool: "create_page", at: 8, toolClass: "write", argsHash: "c1" });
    const dedup = row({
      tool: "create_page",
      at: 9,
      toolClass: "write",
      status: "deduplicated",
      duplicateOf: first.receipt,
      argsHash: "c1",
    });
    const failedAttempt = row({
      tool: "strict_write",
      at: 10,
      toolClass: "write",
      isError: true,
      errorClass: "coercible",
      errorSignature: "limit must be a number",
      argsHash: "x1",
    });
    const thenHeld: LedgerRow = {
      ...row({
        tool: "strict_write",
        at: 11,
        toolClass: "write",
        status: "held",
        held: { reason: "repaired", mode: "repaired" },
        argsHash: "x2",
      }),
      receipt: failedAttempt.receipt,
    };
    const replay = row({
      tool: "write_flaky",
      at: 12,
      toolClass: "write",
      replayOf: dead.receipt,
      argsHash: "w1",
    });
    const all = [
      held,
      executed,
      rejected,
      retried,
      repaired,
      dead,
      first,
      again,
      dedup,
      failedAttempt,
      thenHeld,
      replay,
    ];
    expect(finalRows(all).map((r) => r.receipt)).not.toContain(replay.receipt);
    expect(finalRows(all).find((r) => r.receipt === failedAttempt.receipt)?.status).toBe("held"); // the later word wins
    const r = report(all, {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 100_000),
      minCalls: 1,
    });
    expect(r.calls).toBe(6); // executed, retried, repaired, dead, first, again; holds and dedups are not calls
    expect(r.boundary).toEqual({
      retriesResolved: 1,
      repairsResolved: 1,
      held: { approved: 1, rejected: 1, undecided: 1, cancelled: 0 },
      deadLettered: 1,
      replays: { count: 1, succeeded: 1 },
      deduplicated: 1,
      infrastructure: 1,
    });
    expect(r.unacknowledged).toEqual({
      count: 1,
      tools: [{ tool: "notion/write_flaky", count: 1 }],
    });
    expect(r.duplicates).toMatchObject({
      count: 2,
      tools: [{ tool: "notion/create_page", count: 2 }],
    }); // the repeat the agent got through, and the one the boundary answered
    expect(duplicateWrites(all).map((x) => x.receipt)).toEqual([again.receipt, dedup.receipt]);
    expect(r.topSignatures[0]?.suggestion).toContain("boundary-side");
    expect(r.previous).toBeUndefined();
  });

  it("compares with the previous window and filters by server", () => {
    const rows = [
      row({
        tool: "a",
        at: -50,
        upstream: "old",
        isError: true,
        errorClass: "other",
        errorSignature: "boom",
      }),
      row({ tool: "a", at: -40, upstream: "old" }),
      row({ tool: "a", at: 10, upstream: "old" }),
      row({ tool: "b", at: 20, upstream: "other" }),
    ];
    const r = report(rows, { since: new Date(t0), until: new Date(t0 + 100_000), minCalls: 1 });
    expect(r.calls).toBe(2);
    expect(r.byServer.map((s) => s.server)).toEqual(["old", "other"]);
    expect(r.previous).toMatchObject({ calls: 2, failureRatePct: 50 });
    const only = report(rows, {
      since: new Date(t0),
      until: new Date(t0 + 100_000),
      server: "other",
      minCalls: 1,
    });
    expect(only.calls).toBe(1);
  });

  it("compares the arms of the A/B protocol with intervals and a verdict", () => {
    const rows: LedgerRow[] = [];
    let t = 0;
    // Control: 40 calls, 8 failures each costing a retry (two rows of 300 bytes), 4 unacknowledged writes.
    for (let i = 0; i < 40; i++) {
      const failed = i % 5 === 0;
      rows.push(
        row({
          tool: "create_page",
          toolClass: "write",
          at: t++,
          session: `c${i % 4}`,
          arm: "control",
          isError: failed,
          ...(failed
            ? { errorClass: i % 10 === 0 ? "retryable" : "coercible", errorSignature: "boom" }
            : {}),
        }),
      );
      if (failed)
        rows.push(
          row({
            tool: "create_page",
            toolClass: "write",
            at: t++,
            session: `c${i % 4}`,
            arm: "control",
          }),
        );
    }
    // Treatment: 40 calls, 1 failure, the rest repaired by the boundary; no unacknowledged writes.
    for (let i = 0; i < 40; i++)
      rows.push(
        row({
          tool: "create_page",
          toolClass: "write",
          at: t++,
          session: `t${i % 4}`,
          arm: "treatment",
          ...(i === 3 ? { isError: true, errorClass: "semantic", errorSignature: "gone" } : {}),
          ...(i % 5 === 0 && i !== 3
            ? {
                status: "repaired" as const,
                repairs: [{ path: "/limit", rule: "string-to-number" }],
              }
            : {}),
        }),
      );
    rows.push(row({ tool: "echo", at: t++, session: "x" })); // outside the experiment
    const r = abReport(rows, {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 1_000_000),
      targetCallsPerArm: 30,
    });
    expect(r.outside).toBe(1);
    expect(r.arms.control).toMatchObject({ calls: 48, writes: 48, failures: 8, unacknowledged: 4 });
    expect(r.arms.treatment).toMatchObject({
      calls: 40,
      writes: 40,
      failures: 1,
      unacknowledged: 0,
    });
    expect(r.arms.treatment.boundary.repaired).toBe(8);
    expect(r.arms.control.recoveryBytesPerCall).toBeGreaterThan(
      r.arms.treatment.recoveryBytesPerCall,
    );
    const d = r.differences;
    expect(d.failureRatePct.delta).toBeGreaterThan(0);
    expect(d.failureRatePct.low).toBeLessThanOrEqual(d.failureRatePct.delta);
    expect(d.failureRatePct.high).toBeGreaterThanOrEqual(d.failureRatePct.delta);
    expect(d.unacknowledgedPer1kWrites).toMatchObject({ control: 83.3, treatment: 0 });
    expect(d.recoveryBytesPerCall.delta).toBeGreaterThan(0);
    expect(d.recoveryBytesPerCall.distinguishable).toBe(true);
    // The rows span seconds, so the calls are in but the two weeks are not.
    expect(r.experiment.days).toBe(0);
    expect(r.verdict).toContain(
      "84 more days before the pre-registered minimum (84 days or 30 calls per arm, whichever is later)",
    );
    expect(r.verdict).toContain("Failure tax per call: treatment lowers it by");
    expect(r.verdict.indexOf("Unacknowledged writes")).toBeLessThan(
      r.verdict.indexOf("Failure tax"),
    ); // risk first
    expect(r.arms.control.sessions).toBeGreaterThan(0);
    // Move the last treatment row two weeks out: the span passes and so does the verdict.
    let lastTreatment = -1;
    rows.forEach((x, i) => {
      if (x.arm === "treatment") lastTreatment = i;
    });
    const spread = rows.map((x, i) =>
      i === lastTreatment ? { ...x, ts: new Date(t0 + 90 * 86_400_000).toISOString() } : x,
    );
    const passed = abReport(spread, {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 91 * 86_400_000),
      targetCallsPerArm: 30,
    });
    expect(passed.experiment.days).toBeCloseTo(90, 0);
    expect(passed.verdict).toContain(
      "Both arms passed the pre-registered minimum (84 days and 30 calls per arm)",
    );
    const early = abReport(rows.slice(0, 10), {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 1_000_000),
    });
    expect(early.verdict).toMatch(
      /^\d+ more calls in the smaller arm and 84 more days before the pre-registered minimum \(84 days or 2000 calls per arm/,
    );
    expect(early.differences.recoveryBytesPerCall.distinguishable).toBe(false);
    const empty = abReport([], { since: new Date(t0 - 1000), until: new Date(t0 + 1000) });
    expect(empty.arms.control.calls).toBe(0);
    expect(empty.experiment).toEqual({ first: null, last: null, days: 0 });
    expect(empty.differences.recoveryBytesPerCall).toMatchObject({ low: null, high: null });
    expect(empty.verdict).toContain("not estimable");
    expect(empty.differences.unacknowledgedPer1kWrites).toMatchObject({
      delta: 0,
      distinguishable: false,
    });
  });

  it("brackets a heavy-tailed cost with a bootstrap, decomposes the tax, and projects the fill rate", () => {
    // A tail like the real one: most calls cost nothing to recover, a few cost a great deal.
    const rows: LedgerRow[] = [];
    let t = 0;
    for (const arm of ["control", "treatment"] as const)
      for (let i = 0; i < 200; i++) {
        const fails = arm === "control" ? i % 10 === 0 : i % 25 === 0;
        rows.push(
          row({
            tool: "echo",
            at: t++ * 900,
            arm,
            session: `${arm}-${Math.floor(i / 20)}`,
            toolClass: "write",
            ...(fails
              ? { isError: true, errorClass: "retryable" as const, responseBytes: 200_000 }
              : {}),
          }),
        );
        if (fails)
          rows.push(
            row({
              tool: "echo",
              at: t++ * 900,
              arm,
              session: `${arm}-${Math.floor(i / 20)}`,
              toolClass: "write",
            }),
          );
      }
    const r = abReport(rows, {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 500 * 900 * 1000),
      targetCallsPerArm: 100,
    });
    const d = r.differences;
    // Both intervals answer the same question; the bootstrap makes no normality assumption.
    expect(d.recoveryBytesPerCall.delta).toBe(d.recoveryBytesPerCallRobust.delta);
    expect(d.recoveryBytesPerCallRobust.low).not.toBeNull();
    expect(d.recoveryBytesPerCallRobust.low as number).toBeLessThan(
      d.recoveryBytesPerCallRobust.delta,
    );
    expect(d.recoveryBytesPerCallRobust.high as number).toBeGreaterThan(
      d.recoveryBytesPerCallRobust.delta,
    );
    expect(d.recoveryBytesPerCallRobust.distinguishable).toBe(true); // control pays more
    // Same seed, same interval: the report is reproducible from the ledger.
    const again = abReport(rows, {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 500 * 900 * 1000),
      targetCallsPerArm: 100,
    });
    expect(again.differences.recoveryBytesPerCallRobust).toEqual(d.recoveryBytesPerCallRobust);
    // The tax is a rate times a cost, and control fails more often for the same cost each time.
    expect(r.taxFactors.control.failureRatePct).toBeGreaterThan(
      r.taxFactors.treatment.failureRatePct,
    );
    expect(r.taxFactors.control.bytesPerFailure).toBeGreaterThan(0);
    // Four days of calls: too short to promise a date, whatever the arms already hold.
    expect(r.rate.perArmPerDay).toBeNull();
    expect(r.power.estimable).toBe(true);
    expect(r.power.callsPerArm).toBe(100);
    expect(r.power.failureRateCut === null || r.power.failureRateCut > 0).toBe(true);
  });

  it("says nothing about rate or power until there is enough to say it with", () => {
    const rows = [
      row({ tool: "echo", at: 0, arm: "control", session: "c" }),
      row({ tool: "echo", at: 1, arm: "treatment", session: "t" }),
    ];
    const r = abReport(rows, { since: new Date(t0 - 1000), until: new Date(t0 + 10_000) });
    expect(r.rate).toMatchObject({ perArmPerDay: null, daysToTarget: null, targetDate: null });
    expect(r.power).toMatchObject({
      estimable: false,
      failureTaxBytes: null,
      unacknowledgedCut: null,
      failureRateCut: null,
    });
    expect(r.differences.recoveryBytesPerCallRobust).toMatchObject({ low: null, high: null });
  });

  it("computes Newcombe's interval for the failure-rate difference (10 of 100 against 5 of 100)", () => {
    const rows: LedgerRow[] = [];
    for (const [arm, failures] of [
      ["control", 10],
      ["treatment", 5],
    ] as const)
      for (let i = 0; i < 100; i++)
        rows.push(
          row({
            tool: "echo",
            at: i,
            arm,
            session: `${arm}-${i}`, // one call each: no clustering, so the plain Newcombe maths shows
            ...(i < failures ? { isError: true, errorClass: "semantic" as const } : {}),
          }),
        );
    const plain = abReport(rows, { since: new Date(t0 - 1000), until: new Date(t0 + 1_000_000) });
    const d = plain.differences.failureRatePct;
    // By hand: Wilson 10/100 is 0.0552 to 0.1744, 5/100 is 0.0215 to 0.1118; Newcombe's limits
    // are 0.05 - sqrt(0.0448^2 + 0.0618^2) and 0.05 + sqrt(0.0744^2 + 0.0285^2).
    expect(d).toMatchObject({ control: 10, treatment: 5, delta: 5, distinguishable: false });
    expect(d.low).toBeCloseTo(-2.63, 1);
    expect(d.high).toBeCloseTo(12.96, 1);
    expect(plain.clustering.designEffect).toBe(1);

    // The same counts, every call in one session per arm: the coin was flipped twice, not 200 times,
    // and the interval has to say so or it would call a null result a win.
    const clustered = rows.map((x) => ({ ...x, session: x.arm as string }));
    const c = abReport(clustered, { since: new Date(t0 - 1000), until: new Date(t0 + 1_000_000) });
    expect(c.clustering.designEffect).toBeGreaterThan(1);
    expect(c.differences.failureRatePct.low as number).toBeLessThan(d.low as number);
    expect(c.differences.failureRatePct.high as number).toBeGreaterThan(d.high as number);
  });

  it("parses durations and dates, and diffs shapes", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(parseSince("7d", now).toISOString()).toBe("2026-08-29T12:00:00.000Z");
    expect(parseSince("90m", now).toISOString()).toBe("2026-09-05T10:30:00.000Z");
    expect(parseSince("2026-09-01", now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(() => parseSince("soon", now)).toThrow(/--since/);
    expect(shapeDiff(["a:string", "b:number"], ["a:number", "c:string"])).toBe(
      "added c; removed b; changed a:string->number",
    );
    expect(shapeDiff(["a:string"], ["a:string"])).toBeUndefined();
  });
});
