import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlLedger, type LedgerRow, readLedger } from "./ledger.js";

const row = (n: number): LedgerRow => ({
  receipt: `rcpt_${n}`,
  ts: new Date(0).toISOString(),
  upstream: "u",
  method: "tools/call",
  tool: "t",
  argShape: [],
  argsHash: "h",
  hasIntent: false,
  status: "executed",
  isError: false,
  latencyMs: 1,
  requestBytes: 1,
  responseBytes: 1,
});

describe("JsonlLedger", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it("creates the directory, appends, reads back, tails", () => {
    dir = mkdtempSync(join(tmpdir(), "sayagain-"));
    const path = join(dir, "nested", "ledger.jsonl");
    const ledger = new JsonlLedger(path);
    for (let i = 0; i < 5; i++) ledger.append(row(i));
    expect(readLedger(path)).toHaveLength(5);
    expect(readLedger(path, { tail: 2 }).map((r) => r.receipt)).toEqual(["rcpt_3", "rcpt_4"]);
    expect(readLedger(join(dir, "missing.jsonl"))).toEqual([]);
  });
});
