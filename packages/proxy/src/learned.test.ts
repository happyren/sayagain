import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLearnedCoercions,
  augmentDescription,
  deriveInterventions,
  type Intervention,
  LearnedStore,
  measureLift,
  REVERT_MIN_CALLS,
  upstreamReport,
} from "./learned.js";
import type { LedgerRow } from "./ledger.js";

let seq = 0;
const t0 = Date.parse("2026-09-01T00:00:00Z");
const row = (over: Partial<LedgerRow> & { tool: string; at: number }): LedgerRow => {
  const { at, ...rest } = over;
  seq++;
  return {
    receipt: `r${seq}`,
    ts: new Date(t0 + at * 1000).toISOString(),
    upstream: "fake-notion",
    server: "fake",
    method: "tools/call",
    toolClass: "read-only",
    argShape: ["id:string"],
    argsHash: `h${seq}`,
    hasIntent: false,
    status: "executed",
    isError: false,
    latencyMs: 5,
    requestBytes: 100,
    responseBytes: 100,
    session: "s1",
    ...rest,
  };
};

/** Three coercible failures on strict, each fixed by passing limit as a number, and three not-found failures fixed by reading first. */
function evidence(): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 3; i++) {
    rows.push(
      row({
        tool: "strict",
        at: 10 * i,
        isError: true,
        errorClass: "coercible",
        errorSignature: "Invalid params: limit must be a number",
        argShape: ["limit:string"],
      }),
    );
    rows.push(row({ tool: "strict", at: 10 * i + 1, argShape: ["limit:number"] }));
    rows.push(
      row({
        tool: "update_page",
        at: 10 * i + 2,
        toolClass: "write",
        isError: true,
        errorClass: "semantic",
        errorSignature: "Error: page <str> not found",
      }),
    );
    rows.push(row({ tool: "get_page", at: 10 * i + 3 }));
    rows.push(row({ tool: "update_page", at: 10 * i + 4, toolClass: "write" }));
  }
  return rows;
}

describe("learned", () => {
  it("derives a coercion from a repeated type change and a hint from a repeated precondition", () => {
    const out = deriveInterventions(evidence());
    expect(out.map((i) => i.kind).sort()).toEqual(["coerce", "hint"]); // ranked by waste, so the order varies
    const coerce = out.find((i) => i.kind === "coerce") as Intervention;
    expect(coerce).toMatchObject({
      server: "fake-notion",
      tool: "strict",
      path: "/limit",
      from: "string",
      to: "number",
      rule: "string-to-number",
      evidence: 3,
      state: "active",
    });
    expect(coerce.fact).toBe("`limit` is a number, not a string.");
    expect(coerce.signatures).toEqual(["Invalid params: limit must be a number"]);
    expect(coerce.errorHint).toContain("passing `limit` as a number");
    const hint = out.find((i) => i.kind === "hint") as Intervention;
    expect(hint.fact).toContain("Call `get_page` first");
    expect(hint.errorHint).toContain("calling `get_page` first");
    expect(deriveInterventions(evidence().slice(0, 5))).toEqual([]); // one occurrence is not evidence
  });

  it("applies a coercion only to a matching argument and names the rule", () => {
    const coerce = deriveInterventions(evidence()).find((i) => i.kind === "coerce") as Intervention;
    expect(applyLearnedCoercions({ limit: "10", other: "x" }, [coerce])).toEqual({
      arguments: { limit: 10, other: "x" },
      changes: [
        { path: "/limit", rule: "learned:string-to-number", via: coerce.id, from: "10", to: 10 },
      ],
    });
    expect(applyLearnedCoercions({ limit: 10 }, [coerce])).toBeNull();
    expect(applyLearnedCoercions({ limit: "ten" }, [coerce])).toBeNull();
    expect(applyLearnedCoercions({ limit: "007" }, [coerce])).toBeNull(); // an identifier, not a number
    expect(applyLearnedCoercions({ limit: "12345678901234567890" }, [coerce])).toBeNull(); // lossy
    expect(applyLearnedCoercions({ limit: "10" }, [{ ...coerce, state: "reverted" }])).toBeNull();
  });

  it("augments a description within the cap and leaves the upstream's text intact", () => {
    expect(augmentDescription("Creates a page.", ["`limit` is a number, not a string."])).toBe(
      "Creates a page.\n\n[Say Again learned] `limit` is a number, not a string.",
    );
    expect(augmentDescription(undefined, ["a fact."])).toBe("[Say Again learned] a fact.");
    expect(augmentDescription("x", [])).toBe("x");
    const long = "y".repeat(150);
    expect(augmentDescription("x", [`${long}.`, `${long}.`])).toBe(
      `x\n\n[Say Again learned] ${long}.`,
    );
  });

  it("measures lift around activation and reverts when twenty calls show none", () => {
    const rows = evidence();
    const coerce = deriveInterventions(rows).find((i) => i.kind === "coerce") as Intervention;
    coerce.activatedAt = new Date(t0 + 100_000).toISOString();
    for (let i = 0; i < REVERT_MIN_CALLS; i++)
      rows.push(
        row({
          tool: "strict",
          at: 200 + i,
          isError: i % 2 === 0,
          errorClass: "coercible",
          errorSignature: "Invalid params: limit must be a number",
          argShape: ["limit:string"],
        }),
      );
    const { before, after } = measureLift(rows, coerce, new Date(t0 + 1_000_000));
    expect(before).toMatchObject({ calls: 6, failures: 3, failureRatePct: 50 });
    expect(after).toMatchObject({ calls: 20, failures: 10, failureRatePct: 50 });
    const dir = mkdtempSync(join(tmpdir(), "sayagain-learned-"));
    try {
      const store = new LearnedStore(join(dir, "learned.json"));
      const first = store.reconcile(rows.slice(0, 15), { now: new Date(t0 + 100_000) });
      expect(first.added.map((i) => i.kind).sort()).toEqual(["coerce", "hint"]);
      expect(first.reverted).toEqual([]);
      store.save();
      const again = new LearnedStore(join(dir, "learned.json"));
      expect(again.list()).toHaveLength(2);
      expect(again.coercionsFor("fake", "strict", "fake-notion")).toHaveLength(1);
      expect(again.factsFor("fake-notion", "update_page")).toEqual([
        expect.stringContaining("Call `get_page` first"),
      ]);
      expect(
        again.hintFor("fake", "strict", "Invalid params: limit must be a number", "fake-notion"),
      ).toContain("as a number");
      const second = again.reconcile(rows, { now: new Date(t0 + 1_000_000) });
      expect(second.reverted.map((i) => i.id)).toEqual([coerce.id]);
      expect(again.get(coerce.id)?.reason).toContain("no lift after 20 calls");
      expect(again.coercionsFor("fake", "strict", "fake-notion")).toEqual([]);
      expect(again.get(coerce.id)?.reason).toContain("this failure was 50% of calls before");
      expect(again.setState(coerce.id, "disabled", "disabled by the operator")).toBe(true);
      expect(again.get(coerce.id)?.reason).toMatch(/^disabled by the operator; earlier: no lift/);
      expect(again.setState(coerce.id, "active")).toBe(true);
      expect(again.coercionsFor("fake", "strict", "fake-notion")).toHaveLength(1);
      expect(again.setState("nope", "disabled")).toBe(false);
      const report = upstreamReport("fake-notion", rows, again, 3);
      expect(report).toContain("# Tool definition report: fake-notion");
      expect(report).toContain("## strict: Invalid params: limit must be a number");
      expect(report).toContain("Say Again applies: string-to-number on /limit");
      // Evidence counts the specific change, not the signature: one type change among three recoveries is not enough.
      const mixed = evidence().map((r, k) =>
        k % 5 === 1 && k > 1 ? { ...r, argShape: ["limit:string"] } : r,
      );
      expect(deriveInterventions(mixed).filter((i) => i.kind === "coerce")).toEqual([]);
      // A diff that also added a key teaches nothing.
      const added = evidence().map((r, k) =>
        k % 5 === 1 ? { ...r, argShape: ["limit:number", "title:string"] } : r,
      );
      expect(deriveInterventions(added).filter((i) => i.kind === "coerce")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
