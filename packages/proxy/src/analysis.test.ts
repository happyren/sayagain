import { describe, expect, it } from "vitest";
import {
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
      identicalRetry: true,
      path: ["create_page", "get_page"],
      shapeChange: "changed limit:string->number",
    });
    expect(first?.bytes).toBe(300 * 4);
    expect(recs[2]).toMatchObject({ recovered: false, calls: 10, identicalRetry: false });
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

  it("treats a held-then-approved call as one outcome and counts boundary actions", () => {
    const held: LedgerRow = row({
      tool: "delete_page",
      at: 1,
      toolClass: "destructive",
      status: "held",
      held: { reason: "r", mode: "pre" },
    });
    const executed: LedgerRow = {
      ...row({
        tool: "delete_page",
        at: 2,
        toolClass: "destructive",
        held: { reason: "r", mode: "pre", decision: "approve" },
      }),
      receipt: held.receipt,
    };
    const rejected = row({
      tool: "delete_page",
      at: 3,
      toolClass: "destructive",
      status: "held",
      held: { reason: "r", mode: "pre", decision: "reject" },
    });
    const retried = row({ tool: "flaky", at: 4, attempts: 3 });
    const repaired = row({
      tool: "strict",
      at: 5,
      status: "repaired",
      repairs: [{ path: "limit", rule: "string-to-number" }],
    });
    const dead = row({
      tool: "write_flaky",
      at: 6,
      toolClass: "write",
      status: "dead-lettered",
      isError: true,
      errorClass: "retryable",
      errorSignature: "timed out",
    });
    const dup = row({
      tool: "create_page",
      at: 7,
      toolClass: "write",
      status: "deduplicated",
      duplicateOf: "r1",
    });
    const r = report([held, executed, rejected, retried, repaired, dead, dup], {
      since: new Date(t0 - 1000),
      until: new Date(t0 + 100_000),
      minCalls: 1,
    });
    expect(r.calls).toBe(4); // a rejected hold never became a call
    expect(r.boundary).toEqual({
      retriesResolved: 1,
      repairsResolved: 1,
      held: { approved: 1, rejected: 1, expired: 0, cancelled: 0 },
      deadLettered: 1,
      replays: { count: 0, succeeded: 0 },
      deduplicated: 1,
    });
    expect(r.unacknowledged).toEqual({
      count: 1,
      tools: [{ tool: "notion/write_flaky", count: 1 }],
    });
    expect(r.northStar.unacknowledgedWritesPer1kWrites).toBe(500);
    expect(r.duplicates.count).toBe(1);
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
