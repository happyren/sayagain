import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import type { LedgerRow } from "./ledger.js";

/** The analysis commands over a JSONL ledger under a scratch home, no daemon. */
describe("cli analysis", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  let out = "";
  let err = "";
  beforeEach(() => {
    dir = join(tmpdir(), `sayagain-cli-an-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "home"), { recursive: true });
    for (const k of ["HOME", "SAYAGAIN_HOME"]) saved[k] = process.env[k];
    process.env.HOME = dir;
    process.env.SAYAGAIN_HOME = join(dir, "home");
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err += String(c);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const row = (daysAgo: number, over: Partial<LedgerRow>): LedgerRow => ({
    receipt: `r${Math.random().toString(36).slice(2)}`,
    ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    upstream: "fake-notion",
    server: "notion",
    method: "tools/call",
    tool: "echo",
    toolClass: "read-only",
    argShape: [],
    argsHash: "h",
    hasIntent: false,
    session: "s1",
    status: "executed",
    isError: false,
    latencyMs: 5,
    requestBytes: 10,
    responseBytes: 20,
    ...over,
  });

  it("report, tools and errors read the store, honour --server by either name, and show the previous window", async () => {
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(row(3, { tool: "search" }));
    rows.push(
      row(2, {
        tool: "create_page",
        toolClass: "write",
        isError: true,
        errorClass: "coercible",
        errorSignature: "limit must be a number",
        argShape: ["limit:string"],
      }),
    );
    rows.push(
      row(2 - 1 / 24, { tool: "create_page", toolClass: "write", argShape: ["limit:number"] }),
    );
    rows.push(
      row(9, { tool: "search", isError: true, errorClass: "other", errorSignature: "boom" }),
    ); // previous window
    rows.push(row(9, { tool: "search" }));
    rows.push(row(1, { upstream: "linear", server: "linear", tool: "issues", session: "s2" }));
    writeFileSync(
      join(dir, "home", "ledger.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );

    expect(await main(["report", "--since", "7d"])).toBe(0);
    expect(out).toContain("Say Again report:");
    expect(out).toContain("15 calls, 2 writes");
    expect(out).toContain("What moved vs the previous 7 days: calls 2 -> 15");
    expect(out).toContain("fake-notion/create_page x1 coercible");
    out = "";
    expect(
      await main(["tools", "--since", "7d", "--min-calls", "1", "--server", "notion", "--json"]),
    ).toBe(0);
    const tools = JSON.parse(out) as {
      tool: string;
      server: string;
      calls: number;
      failureRatePct: number;
    }[];
    expect(tools.map((t) => t.tool)).toEqual(["create_page", "search"]);
    expect(tools[0]).toMatchObject({ server: "fake-notion", calls: 2, failureRatePct: 50 });
    out = "";
    expect(
      await main(["tools", "--since", "7d", "--min-calls", "1", "--server", "linear", "--json"]),
    ).toBe(0);
    expect((JSON.parse(out) as { tool: string }[]).map((t) => t.tool)).toEqual(["issues"]);
    out = "";
    expect(await main(["errors", "create_page", "--since", "7d"])).toBe(0);
    expect(out).toContain("limit must be a number");
    expect(out).toContain("shape change: changed limit:string->number");
    expect(out).toContain("suggestion: deterministic coercion");
    out = "";
    expect(await main(["errors", "nothing", "--since", "7d"])).toBe(0);
    expect(out).toContain("no failures");
    await expect(main(["report", "--since", "next week"])).rejects.toThrow(/--since/);
    await expect(main(["report", "--since", "2999-01-01"])).rejects.toThrow(/in the past/);
  });

  it("lint --file grades a tools/list response and --fail-below sets the exit code", async () => {
    const file = join(dir, "tools.json");
    writeFileSync(
      file,
      JSON.stringify({
        result: {
          tools: [
            {
              name: "good_tool",
              description:
                "Creates a page in the workspace and returns its id. Fails when the parent is missing.",
              inputSchema: {
                type: "object",
                properties: { parent: { type: "string", description: "Parent page id" } },
                required: ["parent"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            { name: "bad", inputSchema: { type: "object" } },
          ],
        },
      }),
    );
    expect(await main(["lint", "--file", file])).toBe(0);
    expect(out).toMatch(/tools\.json: 2 tool\(s\)/);
    expect(out).toMatch(/ {2}[DF] {2}bad/);
    expect(await main(["lint", "--file", file, "--fail-below", "C"])).toBe(1);
    expect(err).toContain("graded below C");
    await expect(main(["lint", "--file", join(dir, "missing.json")])).rejects.toThrow(
      /cannot read/,
    );
    await expect(main(["lint", "x", "--file", file])).rejects.toThrow(
      /--file takes no server name/,
    );
  });
});
