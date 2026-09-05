import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DeadLetter, DeadLetterStore, readDeadLetters } from "./deadletter.js";

const entry = (receipt: string): DeadLetter => ({
  receipt,
  ts: "t",
  upstream: "u",
  tool: "x",
  rawLine: "{}",
  errorClass: "other",
  errorSignature: "s",
  attempts: 1,
  repairs: 0,
});

describe("DeadLetterStore", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it("hydrates from the file and folds resolutions", () => {
    dir = mkdtempSync(join(tmpdir(), "sayagain-dl-"));
    const path = join(dir, "dl.jsonl");
    const a = new DeadLetterStore(path);
    a.add(entry("r1"));
    a.add(entry("r2"));
    expect(a.resolve("r1", "rcpt_replay")).toBe(true);
    expect(a.resolve("r1", "again")).toBe(false);
    const b = new DeadLetterStore(path);
    expect(b.list().map((d) => d.receipt)).toEqual(["r2"]);
    expect(b.get("r1")).toBeUndefined();
    expect(b.get("r2")?.receipt).toBe("r2");
    expect(readDeadLetters(path).map((d) => d.receipt)).toEqual(["r2"]);
    expect(readDeadLetters(path, { includeResolved: true })).toHaveLength(2);
  });
});
