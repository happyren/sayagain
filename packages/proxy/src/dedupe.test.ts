import { describe, expect, it } from "vitest";
import { DedupeCache } from "./dedupe.js";

describe("DedupeCache", () => {
  it("remembers within the window and forgets after it", () => {
    const c = new DedupeCache(1000);
    c.remember("k", "rcpt_1", { ok: true }, 0);
    expect(c.lookup("k", 500)?.receipt).toBe("rcpt_1");
    expect(c.lookup("k", 1500)).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
