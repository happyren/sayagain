import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./daemon.js";
import { runStdioShim } from "./shim.js";
import { openStores } from "./stores.js";

const fixture = new URL("../test/fake-server.mjs", import.meta.url).pathname;

describe("daemon", () => {
  let home = "";
  let daemon: Daemon | undefined;
  const logs: string[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sayagain-daemon-"));
    process.env.SAYAGAIN_HOME = home;
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    process.env.SAYAGAIN_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const boot = async (ledger: "jsonl" | "sqlite" | "memory" = "memory") => {
    const stores = openStores(ledger, { log: (l) => logs.push(l) });
    daemon = await startDaemon({
      registry: {
        servers: {
          fake: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            hold: "destructive",
          },
        },
      },
      stores,
      version: "0.4.0-test",
      listen: "127.0.0.1:0",
      log: (l) => logs.push(l),
    });
    return daemon;
  };
  const rpc = async (d: Daemon, name: string, msg: unknown, token = d.token) => {
    const res = await fetch(`${d.url}/mcp/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    return {
      status: res.status,
      body: (res.status === 202 ? {} : ((await res.json()) as Record<string, unknown>)) as Record<
        string,
        unknown
      >,
    };
  };
  const api = async (d: Daemon, path: string, init: RequestInit = {}) =>
    (
      await fetch(`${d.url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${d.token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      })
    ).json() as Promise<Record<string, unknown> | unknown[]>;

  it("serves a registered upstream over HTTP with receipts, and rejects bad tokens and unknown names", async () => {
    const d = await boot();
    expect(
      (await rpc(d, "fake", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "wrong"))
        .status,
    ).toBe(401);
    expect(
      (await rpc(d, "nope", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status,
    ).toBe(404);
    const init = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect(init.status).toBe(200);
    const result = init.body.result as Record<string, unknown>;
    expect(result.serverInfo).toEqual({ name: "fake-notion", version: "9.9.9" });
    expect((result._meta as Record<string, unknown>)["sh.sayagain/boundary"]).toMatchObject({
      upstream: "fake-notion",
      hold: "destructive",
    });
    expect(
      (await rpc(d, "fake", { jsonrpc: "2.0", method: "notifications/initialized" })).status,
    ).toBe(202);
    const call = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    expect(
      ((call.body.result as Record<string, unknown>)._meta as Record<string, unknown>)[
        "sh.sayagain/status"
      ],
    ).toBe("executed");
    const list = await rpc(d, "fake", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(
      ((list.body.result as Record<string, unknown>).tools as unknown[]).length,
    ).toBeGreaterThan(3);
    const health = (await api(d, "/api/health")) as Record<string, unknown>;
    expect(health.servers).toEqual(["fake"]);
  });

  it("lets two hosts share one upstream and dedupes across them", async () => {
    const d = await boot();
    const a = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: "a1",
      method: "tools/call",
      params: { name: "create_page", arguments: { t: 1 } },
    });
    const b = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "create_page", arguments: { t: 1 } },
    });
    expect(a.body.id).toBe("a1");
    expect(b.body.id).toBe(7);
    expect(
      ((b.body.result as Record<string, unknown>)._meta as Record<string, unknown>)[
        "sh.sayagain/status"
      ],
    ).toBe("deduplicated");
    const servers = (await api(d, "/api/servers")) as {
      name: string;
      started: boolean;
      upstream: string;
    }[];
    expect(servers[0]).toMatchObject({ name: "fake", started: true, upstream: "fake-notion" });
  });

  it("holds a destructive call and completes it through the API", async () => {
    const d = await boot("sqlite");
    const pending = rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "delete_page",
        arguments: { id: 9 },
        _meta: { "sh.sayagain/intent": "drop it" },
      },
    });
    let holds: { receipt: string; intent?: string }[] = [];
    for (let i = 0; i < 50 && !holds.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      holds = (await api(d, "/api/holds")) as { receipt: string; intent?: string }[];
    }
    expect(holds[0]).toMatchObject({
      tool: "delete_page",
      intent: "drop it",
      upstream: "fake",
      mode: "pre",
    });
    const decided = (await api(d, `/api/holds/${holds[0]?.receipt}/approve`, {
      method: "POST",
    })) as { decided: boolean };
    expect(decided.decided).toBe(true);
    const done = await pending;
    expect(
      ((done.body.result as Record<string, unknown>)._meta as Record<string, unknown>)[
        "sh.sayagain/held"
      ],
    ).toMatchObject({ decision: "approve" });
    const ledger = (await api(d, "/api/ledger?tail=5")) as { tool: string; status: string }[];
    expect(ledger.some((r) => r.tool === "delete_page" && r.status === "executed")).toBe(true);
  });

  it("dead-letters, lists, replays and resolves through the API with SQLite storage", async () => {
    const d = await boot("sqlite");
    const dead = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "strict", arguments: { limit: "10", tags: { nested: true } } },
    });
    const meta = (dead.body.result as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["sh.sayagain/status"]).toBe("dead-lettered");
    const receipt = String(meta["sh.sayagain/receipt"]);
    expect(
      ((await api(d, "/api/deadletters")) as { receipt: string }[]).map((x) => x.receipt),
    ).toEqual([receipt]);
    const outcome = (await api(d, `/api/replay/${receipt}`, {
      method: "POST",
      body: JSON.stringify({ arguments: { limit: 10, tags: "ok" } }),
    })) as { isError: boolean; replayOf: string };
    expect(outcome).toMatchObject({ isError: false, replayOf: receipt });
    expect(await api(d, "/api/deadletters")).toEqual([]);
  });

  it("drives the stdio shim end to end against the daemon", async () => {
    await boot();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    output.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    const run = runStdioShim({
      name: "fake",
      input,
      output,
      autoStart: false,
      log: (l) => logs.push(l),
    });
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { via: "shim" } } })}\n`,
    );
    for (let i = 0; i < 100 && !lines.find((m) => m.id === 2); i++)
      await new Promise((r) => setTimeout(r, 30));
    const reply = lines.find((m) => m.id === 2) as Record<string, unknown>;
    expect(
      ((reply.result as Record<string, unknown>)._meta as Record<string, unknown>)[
        "sh.sayagain/receipt"
      ],
    ).toMatch(/^rcpt_/);
    input.end();
    expect(await run).toBe(0);
  });
});
