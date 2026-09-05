import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStores, sqliteAvailable } from "./stores.js";

describe("openStores", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it.skipIf(!sqliteAvailable())("sqlite: ledger, dead letters and holds survive reopening", () => {
    dir = mkdtempSync(join(tmpdir(), "sayagain-sqlite-"));
    const path = join(dir, "t.db");
    const a = openStores("sqlite", { sqlitePath: path });
    expect(a.kind).toBe("sqlite");
    a.ledger.append({
      receipt: "r1",
      ts: "t",
      upstream: "u",
      method: "tools/call",
      tool: "x",
      toolClass: "write",
      argShape: [],
      argsHash: "h",
      hasIntent: false,
      status: "executed",
      isError: false,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
    });
    a.deadLetters.add({
      receipt: "d1",
      ts: "t",
      upstream: "u",
      tool: "x",
      rawLine: "{}",
      errorClass: "other",
      errorSignature: "s",
      attempts: 1,
      repairs: 0,
    });
    a.holds.save({
      receipt: "h1",
      tool: "x",
      toolClass: "destructive",
      reason: "r",
      arguments: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      upstream: "u",
      mode: "pre",
    });
    a.close();
    const b = openStores("sqlite", { sqlitePath: path });
    expect(b.readLedger(10).map((r) => r.receipt)).toEqual(["r1"]);
    expect(b.deadLetters.get("d1")?.tool).toBe("x");
    expect(b.deadLetters.resolve("d1", "r2")).toBe(true);
    expect(b.deadLetters.list()).toEqual([]);
    expect(b.holds.pending().map((h) => h.receipt)).toEqual(["h1"]);
    b.holds.decide("h1", "approve");
    expect(b.holds.pending()).toEqual([]);
    b.close();
  });
  it("jsonl: the default", () => {
    dir = mkdtempSync(join(tmpdir(), "sayagain-jsonl-"));
    const s = openStores("jsonl", {
      ledgerPath: join(dir, "l.jsonl"),
      deadLetterPath: join(dir, "d.jsonl"),
      holdsPath: join(dir, "h.jsonl"),
    });
    expect(s.kind).toBe("jsonl");
    s.ledger.append({
      receipt: "r1",
      ts: "t",
      upstream: "u",
      method: "tools/call",
      tool: "x",
      toolClass: "write",
      argShape: [],
      argsHash: "h",
      hasIntent: false,
      status: "executed",
      isError: false,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
    });
    expect(s.readLedger(1)).toHaveLength(1);
    expect(s.readLedger(0)).toEqual([]);
    s.holds.save({
      receipt: "h1",
      tool: "x",
      toolClass: "destructive",
      reason: "r",
      arguments: { a: 1 },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    s.holds.save({
      receipt: "h2",
      tool: "y",
      toolClass: "destructive",
      reason: "r",
      arguments: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    s.holds.decide("h1", "reject");
    const again = openStores("jsonl", {
      ledgerPath: join(dir, "l.jsonl"),
      deadLetterPath: join(dir, "d.jsonl"),
      holdsPath: join(dir, "h.jsonl"),
    });
    expect(again.holds.pending().map((h) => h.receipt)).toEqual(["h2"]);
  });
});
