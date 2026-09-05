import { describe, expect, it } from "vitest";
import { DedupeCache } from "./dedupe.js";

describe("DedupeCache", () => {
  it("keys on the idempotency key first, then a task-scoped write fingerprint, never on reads", () => {
    expect(
      DedupeCache.keyFor({
        tool: "t",
        toolClass: "write",
        idempotencyKey: "k",
        clientArgsHash: "h",
      }),
    ).toBe("key:t:k");
    expect(DedupeCache.keyFor({ tool: "t", toolClass: "write", clientArgsHash: "h" })).toBe(
      "fp:-:t:h",
    );
    expect(
      DedupeCache.keyFor({ tool: "t", toolClass: "write", clientArgsHash: "h", task: "T" }),
    ).toBe("fp:T:t:h");
    expect(
      DedupeCache.keyFor({ tool: "t", toolClass: "read-only", clientArgsHash: "h" }),
    ).toBeNull();
  });
  it("remembers within the window and forgets after it", () => {
    const c = new DedupeCache(1000);
    c.remember("k", "rcpt_1", { ok: true }, 0);
    expect(c.lookup("k", 500)?.receipt).toBe("rcpt_1");
    expect(c.lookup("k", 1500)).toBeUndefined();
    expect(c.size).toBe(0);
  });
  it("hands a concurrent caller the first call's settlement", async () => {
    const c = new DedupeCache(1000);
    const first = c.reserve("k");
    const second = c.reserve("k");
    expect("settle" in first).toBe(true);
    expect("existing" in second).toBe(true);
    if ("settle" in first) first.settle({ receipt: "rcpt_1", result: {}, at: 0 });
    if ("existing" in second) expect((await second.existing)?.receipt).toBe("rcpt_1");
    expect("settle" in c.reserve("k")).toBe(true);
  });
});
