import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerRow } from "./ledger.js";
import { overviewFor } from "./overview.js";

const row = (server: string | undefined, ts: string, extra: Partial<LedgerRow> = {}): LedgerRow =>
  ({
    ts,
    ...(server !== undefined ? { server } : {}),
    upstream: "Upstream",
    tool: "t",
    toolClass: "write",
    status: "executed",
    isError: false,
    receipt: `r-${ts}`,
    ...extra,
  }) as unknown as LedgerRow;

/** Everything the overview reads from disk lives under a scratch home, so the test sees only what it wrote. */
describe("overview", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = join(tmpdir(), `sayagain-overview-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    for (const k of ["HOME", "SAYAGAIN_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"])
      saved[k] = process.env[k];
    process.env.HOME = dir;
    process.env.SAYAGAIN_HOME = join(dir, "sayagain");
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    // Cursor names notion and calls it directly; nobody names quiet.
    writeFileSync(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { notion: { command: "n" } } }),
    );
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const registry = {
    servers: {
      notion: { transport: "stdio" as const, command: "n" },
      quiet: { transport: "http" as const, url: "http://127.0.0.1:1/mcp" },
    },
    daemon: { hold: "never" as const },
  };
  const now = Date.parse("2026-09-06T12:00:00Z");
  const base = {
    registry,
    version: "0.20.0",
    listen: "127.0.0.1:7777",
    arm: null,
    startedAt: "2026-09-06T11:00:00Z",
    live: { notion: { ready: true, upstream: "Notion", sessions: 1 } },
    holds: [{ receipt: "h1", tool: "t", server: "notion", createdAt: now - 1000 }],
    cwd: dir,
    now,
  };

  it("counts per server as the report counts, names the mode, and carries the doctor's findings", () => {
    const o = overviewFor({
      ...base,
      rows: [
        row("notion", "2026-09-06T11:30:00Z"),
        row("notion", "2026-09-06T11:40:00Z", { isError: true, errorClass: "other" }),
        row("notion", "2026-09-06T11:20:00Z"),
      ],
    });
    expect(o.daemon).toMatchObject({ version: "0.20.0", hold: "never", listen: "127.0.0.1:7777" });
    expect(o.calls).toBe(3);
    expect(o.servers).toEqual([
      {
        name: "notion",
        transport: "stdio",
        started: true,
        ready: true,
        upstream: "Notion",
        sessions: 1,
        calls: 3,
        failures: 1,
        held: 1,
        lastSeen: "2026-09-06T11:40:00Z",
        hosts: { named: 1, wrapped: 0 },
      },
      {
        name: "quiet",
        transport: "http",
        started: false,
        ready: false,
        upstream: null,
        sessions: 0,
        calls: 0,
        failures: 0,
        held: 0,
        lastSeen: null,
        hosts: { named: 0, wrapped: 0 },
      },
    ]);
    // The doctor runs with what the daemon knows: holds off is a note with its command, the host
    // that calls notion directly is named, and the classes it could not check are not a finding.
    expect(o.doctor.find((f) => f.title.includes("holds are off"))).toMatchObject({
      severity: "note",
      fix: "sayagain up --hold",
    });
    expect(o.doctor.find((f) => f.title.includes("calls a server directly"))).toMatchObject({
      severity: "warning",
    });
    expect(o.doctor.some((f) => f.title.includes("tool classes were not checked"))).toBe(false);
    const order = { error: 0, warning: 1, note: 2, ok: 3 };
    for (let i = 1; i < o.doctor.length; i++)
      expect(order[o.doctor[i - 1]?.severity ?? "ok"]).toBeLessThanOrEqual(
        order[o.doctor[i]?.severity ?? "ok"],
      );
  });

  it("folds attempts, holds, read-backs and replays into one call, and leaves out what the registry does not know", () => {
    const o = overviewFor({
      ...base,
      rows: [
        // One call: held, then executed on approval; its read-back and a replay of it are not calls.
        row("notion", "2026-09-06T11:00:00Z", { receipt: "r1", status: "held" }),
        row("notion", "2026-09-06T11:01:00Z", { receipt: "r1", status: "executed" }),
        row("notion", "2026-09-06T11:02:00Z", {
          receipt: "r2",
          verifies: "r1",
          toolClass: "read-only",
        }),
        row("notion", "2026-09-06T11:03:00Z", { receipt: "r3", replayOf: "r1" }),
        // A duplicate answered from memory is not a call the server ran; a still-held one has no outcome yet.
        row("notion", "2026-09-06T11:04:00Z", { receipt: "r4", status: "deduplicated" }),
        row("notion", "2026-09-06T11:05:00Z", { receipt: "r5", status: "held" }),
        // An unknown outcome is not a failure the agent recovered from.
        row("notion", "2026-09-06T11:06:00Z", {
          receipt: "r6",
          isError: true,
          errorClass: "interrupt",
        }),
        // Keyed by an upstream's own name, or by a wrap outside the daemon: nobody's here.
        row(undefined, "2026-09-06T11:07:00Z", { receipt: "r7" }),
        row("upstream", "2026-09-06T11:08:00Z", { receipt: "r8" }),
      ],
    });
    expect(o.servers[0]).toMatchObject({
      name: "notion",
      calls: 2,
      failures: 0,
      lastSeen: "2026-09-06T11:06:00Z",
    });
    expect(o.calls).toBe(2);
  });
});
