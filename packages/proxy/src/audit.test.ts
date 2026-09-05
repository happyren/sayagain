import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAuditHtml, renderAuditText, runAudit } from "./audit.js";
import {
  SECRETS,
  T0,
  writeClaudeCodeFixture,
  writeCodexFixture,
  writeCursorFixture,
} from "./test-fixtures/transcripts.js";
import { scanTranscripts } from "./transcripts.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sayagain-audit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("audit", () => {
  it("prints the one page risk first, with dollars, and a page that carries no values", () => {
    const dirs = {
      "claude-code": join(root, "claude"),
      codex: join(root, "codex"),
      cursor: join(root, "cursor"),
    };
    writeClaudeCodeFixture(dirs["claude-code"]);
    writeCodexFixture(dirs.codex);
    writeCursorFixture(dirs.cursor);
    const scan = scanTranscripts({ dirs });
    const a = runAudit(
      scan.sessions,
      {
        since: new Date(T0 - 86_400_000),
        // Cursor lines carry no timestamps; their calls fall back to the file time, i.e. now.
        until: new Date(Date.now() + 60_000),
        minCalls: 1,
        version: "t",
      },
      scan.files,
    );
    expect(a.sources.map((s) => [s.source, s.sessions, s.calls, s.mcpCalls])).toEqual([
      ["claude-code", 1, 8, 5],
      ["codex", 1, 4, 1],
      ["cursor", 2, 4, 1],
    ]);
    expect(a.report.calls).toBe(16);
    expect(a.tokens).toBe(7320 + 1100 + 550 + 210);
    expect(a.usd).toBeGreaterThan(0);
    expect(a.families).toMatchObject({ claude: 8, gpt: 4, unknown: 4 });
    // Failures: notion create_page (coercible), codex exec_command, apply_patch, cursor create_issue.
    expect(a.recoveryCost.failures).toBe(4);
    expect(a.failureTax.usd).toBeGreaterThan(0);
    // usd is rounded to cents; the per-1K figure is not, so bound it rather than match it.
    expect(a.failureTax.usdPer1kCalls).toBeGreaterThan((1000 * (a.failureTax.usd - 0.005)) / 16);
    expect(a.failureTax.usdPer1kCalls).toBeLessThanOrEqual(
      (1000 * (a.failureTax.usd + 0.005)) / 16,
    );
    expect(a.failureTax.shareOfSpendPct).toBeGreaterThan(0);
    expect(Number.isInteger(a.failureTax.annualisedUsd)).toBe(true); // whole dollars; the fixture's tax rounds to 0 a year
    expect(a.report.northStar.unacknowledgedWritesPer1kWrites).toBeGreaterThan(0);
    expect(a.sessionsEndedOnFailure).toMatchObject({ sessions: 4 });
    expect(a.classing).toEqual({ defaultedWrites: 0, defaultedBuiltins: 0 });
    expect(a.caveats.some((c) => c.includes("no tool results"))).toBe(true);
    expect(a.caveats.some((c) => c.includes("Cursor transcripts carry no token usage"))).toBe(true);
    expect(a.tools.length).toBeGreaterThan(0);
    const notion = a.tools.find((t) => t.server === "notion" && t.tool === "create_page");
    expect(notion).toMatchObject({ calls: 3, failures: 1, misCallRatePct: 33.3 });
    expect(notion?.wasteUsd).toBeGreaterThan(0);
    expect(notion?.topSignature?.errorClass).toBe("coercible");

    const text = renderAuditText(a);
    expect(text).toContain("North star (risk, then cost)");
    expect(text.indexOf("unacknowledged")).toBeLessThan(text.indexOf("failure tax"));
    expect(text).toContain("Failures by server (M1 rate, M7 addressable share)");
    expect(text).toContain("Duplicates (M8): 1 writes repeated");
    expect(text).toContain("Tools most prone to mis-calls");
    expect(text).toContain("Caveats");
    const html = renderAuditHtml(a);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script");
    expect(html).toContain("unacknowledged writes");
    expect(html.indexOf("unacknowledged writes")).toBeLessThan(html.indexOf("failure tax"));
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
      expect(html).not.toContain(secret);
      expect(JSON.stringify(a)).not.toContain(secret);
    }
    expect(JSON.stringify(a)).not.toContain("Invalid params: limit must be a number (see https");
  });

  it("copes with no transcripts at all", () => {
    const a = runAudit([], { since: new Date(T0), until: new Date(T0 + 1000) });
    expect(a.report.calls).toBe(0);
    expect(a.failureTax).toEqual({
      usd: 0,
      usdPer1kCalls: 0,
      shareOfSpendPct: 0,
      shareOfTokensPct: 0,
      annualisedUsd: 0,
    });
    expect(renderAuditText(a)).toContain("no transcripts found");
    expect(renderAuditHtml(a)).toContain("no transcripts found");
  });
});
