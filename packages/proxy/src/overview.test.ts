import { describe, expect, it } from "vitest";
import type { LedgerRow } from "./ledger.js";
import { overviewFor } from "./overview.js";

const row = (server: string, ts: string, isError = false): LedgerRow =>
  ({
    ts,
    server,
    upstream: server,
    tool: "t",
    toolClass: "write",
    status: "executed",
    isError,
    receipt: `r-${ts}`,
  }) as unknown as LedgerRow;

describe("overview", () => {
  it("sums the window per server, names the mode, and carries the doctor's findings", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    const o = overviewFor({
      registry: {
        servers: {
          notion: { transport: "stdio", command: "n" },
          quiet: { transport: "http", url: "http://127.0.0.1:1/mcp" },
        },
        daemon: { hold: "never" },
      },
      version: "0.20.0",
      listen: "127.0.0.1:7777",
      arm: null,
      startedAt: "2026-09-06T11:00:00Z",
      rows: [
        row("notion", "2026-09-06T11:30:00Z"),
        row("notion", "2026-09-06T11:40:00Z", true),
        row("notion", "2026-09-06T11:20:00Z"),
      ],
      live: { notion: { ready: true, upstream: "Notion", sessions: 1 } },
      holds: [{ receipt: "h1", tool: "t", server: "notion", createdAt: now - 1000 }],
      cwd: "/nowhere",
      now,
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
      },
    ]);
    // The doctor runs with what the daemon knows: holds off is a note with its command, and the
    // server that never called is named.
    expect(o.doctor.find((f) => f.title.includes("holds are off"))).toMatchObject({
      severity: "note",
      fix: "sayagain up --hold",
    });
    expect(o.doctor.some((f) => f.severity === "ok" && f.title.includes("0.20.0"))).toBe(true);
    for (let i = 1; i < o.doctor.length; i++) {
      const order = { error: 0, warning: 1, note: 2, ok: 3 };
      expect(order[o.doctor[i - 1]?.severity ?? "ok"]).toBeLessThanOrEqual(
        order[o.doctor[i]?.severity ?? "ok"],
      );
    }
  });
});
