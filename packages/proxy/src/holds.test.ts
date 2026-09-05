import { describe, expect, it } from "vitest";
import { type Hold, HoldQueue } from "./holds.js";

const hold = (receipt: string): Hold => ({
  receipt,
  tool: "delete_page",
  toolClass: "destructive",
  reason: "r",
  arguments: {},
  createdAt: 0,
  expiresAt: 10,
});

describe("HoldQueue", () => {
  it("lists pending holds, resolves waiters on decision, refuses double decisions", async () => {
    const q = new HoldQueue();
    q.create(hold("a"));
    q.create(hold("b"));
    expect(q.list().map((h) => h.receipt)).toEqual(["a", "b"]);
    const waiting = q.waitFor("a", 1000);
    expect(q.decide("a", "approve")).toBe(true);
    expect(await waiting).toBe("approve");
    expect(q.decide("a", "reject")).toBe(false);
    expect(q.decide("zzz", "approve")).toBe(false);
    expect(q.list().map((h) => h.receipt)).toEqual(["b"]);
  });

  it("times out without a decision and keeps the hold open", async () => {
    const q = new HoldQueue();
    q.create(hold("c"));
    expect(await q.waitFor("c", 20)).toBeUndefined();
    expect(q.list()).toHaveLength(1);
    expect(await q.waitFor("c", 20)).toBeUndefined();
    q.decide("c", "reject");
    expect(await q.waitFor("c", 20)).toBe("reject");
  });
});
