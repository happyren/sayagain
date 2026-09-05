import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./daemon.js";
import { runStdioShim } from "./shim.js";
import { openStores, sqliteAvailable } from "./stores.js";

const fixture = new URL("../test/fake-server.mjs", import.meta.url).pathname;
type Obj = Record<string, unknown>;
const meta = (body: Obj): Obj => ((body.result as Obj)?._meta as Obj) ?? {};

describe("daemon", () => {
  let home = "";
  let previousHome: string | undefined;
  let daemon: Daemon | undefined;
  const logs: string[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sayagain-daemon-"));
    previousHome = process.env.SAYAGAIN_HOME;
    process.env.SAYAGAIN_HOME = home;
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (previousHome === undefined) delete process.env.SAYAGAIN_HOME;
    else process.env.SAYAGAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const boot = async (
    ledger: "jsonl" | "sqlite" | "memory" = "memory",
    extra: Record<string, unknown> = {},
  ) => {
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
      ...extra,
    });
    return daemon;
  };
  const rpc = async (
    d: Daemon,
    name: string,
    msg: unknown,
    opts: { token?: string; session?: string } = {},
  ) => {
    const res = await fetch(`${d.url}/mcp/${name}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token ?? d.token}`,
        "content-type": "application/json",
        ...(opts.session ? { "mcp-session-id": opts.session } : {}),
      },
      body: JSON.stringify(msg),
    });
    const body: Obj = res.status === 202 || res.status === 204 ? {} : ((await res.json()) as Obj);
    const out: { status: number; body: Obj; session?: string } = { status: res.status, body };
    const sid = res.headers.get("mcp-session-id");
    if (sid) out.session = sid;
    return out;
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
    ).json() as Promise<Obj | unknown[]>;
  const initMsg = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  };
  const until = async <T>(probe: () => Promise<T | undefined>, ms = 3000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await probe();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("serves a registered upstream over HTTP with receipts, and rejects bad tokens and unknown names", async () => {
    const d = await boot();
    expect((await rpc(d, "fake", initMsg, { token: "wrong" })).status).toBe(401);
    expect((await rpc(d, "nope", initMsg)).status).toBe(404);
    const init = await rpc(d, "fake", initMsg);
    expect(init.status).toBe(200);
    expect(init.session).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    const result = init.body.result as Obj;
    expect(result.serverInfo).toEqual({ name: "fake-notion", version: "9.9.9" });
    expect((result._meta as Obj)["sh.sayagain/boundary"]).toMatchObject({
      upstream: "fake-notion",
      hold: "destructive",
      ledger: "memory",
    });
    expect(
      (
        await rpc(
          d,
          "fake",
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { session: init.session ?? "" },
        )
      ).status,
    ).toBe(202);
    const call = await rpc(
      d,
      "fake",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { a: 1 } },
      },
      { session: init.session ?? "" },
    );
    expect(meta(call.body)["sh.sayagain/status"]).toBe("executed");
    const withSession = (await api(d, "/api/ledger?tail=1")) as { session?: string }[];
    expect(withSession[0]?.session).toBe(init.session); // a host that presented Mcp-Session-Id is one stream
    const list = await rpc(d, "fake", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(((list.body.result as Obj).tools as unknown[]).length).toBeGreaterThan(3);
    expect(
      (
        await rpc(
          d,
          "fake",
          { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
          { session: "nope" },
        )
      ).status,
    ).toBe(404);
    const health = (await api(d, "/api/health")) as Obj;
    expect(health).toMatchObject({ servers: ["fake"], ledger: "memory" });
  });

  it("lets two hosts share one upstream: same request ids, cross-host dedupe, one process", async () => {
    const d = await boot();
    const a = rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { who: "a" } },
    });
    const b = rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { who: "b" } },
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body.id).toBe(1);
    expect(rb.body.id).toBe(1);
    const textOf = (r: Obj) => String(((r.result as Obj).content as { text: string }[])[0]?.text);
    expect(textOf(ra.body)).toContain('"who":"a"');
    expect(textOf(rb.body)).toContain('"who":"b"');
    const w1 = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: "w",
      method: "tools/call",
      params: { name: "create_page", arguments: { t: 1 } },
    });
    const w2 = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "create_page", arguments: { t: 1 } },
    });
    expect(meta(w1.body)["sh.sayagain/status"]).toBe("executed");
    expect(meta(w2.body)["sh.sayagain/status"]).toBe("deduplicated");
    const servers = (await api(d, "/api/servers")) as {
      name: string;
      started: boolean;
      upstream: string;
    }[];
    expect(servers[0]).toMatchObject({ name: "fake", started: true, upstream: "fake-notion" });
  });

  it("holds a destructive call and completes it through the API", async () => {
    const d = await boot();
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
    const hold = await until(async () => ((await api(d, "/api/holds")) as Obj[])[0]);
    expect(hold).toMatchObject({
      tool: "delete_page",
      intent: "drop it",
      upstream: "fake-notion",
      server: "fake",
      mode: "pre",
    });
    expect(hold.orphaned).toBeUndefined();
    const decided = (await api(d, `/api/holds/${hold.receipt}/approve`, { method: "POST" })) as {
      decided: boolean;
    };
    expect(decided.decided).toBe(true);
    const done = await pending;
    expect(meta(done.body)["sh.sayagain/held"]).toMatchObject({ decision: "approve" });
    const ledger = (await api(d, "/api/ledger?tail=5")) as {
      tool: string;
      status: string;
      session?: string;
      server?: string;
    }[];
    expect(ledger.some((r) => r.tool === "delete_page" && r.status === "executed")).toBe(true);
    // A one-shot POST has no stable session, so its rows carry none; the registry name is always there.
    expect(ledger.every((r) => r.server === "fake" && r.session === undefined)).toBe(true);
    const since = (await api(
      d,
      `/api/ledger?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&tail=1`,
    )) as unknown[];
    expect(since).toHaveLength(1);
    expect(await api(d, "/api/ledger?since=garbage")).toMatchObject({
      error: expect.stringContaining("ISO"),
    });
    expect((await api(d, "/api/ledger?tail=0")) as unknown[]).toEqual([]);
  });

  it("keeps a held call across a restart, lists it as orphaned, and executes it on approve", async () => {
    const stores = () => openStores("jsonl", { log: (l) => logs.push(l) });
    const first = await startDaemon({
      registry: {
        servers: { fake: { transport: "stdio", command: process.execPath, args: [fixture] } },
      },
      stores: stores(),
      version: "t",
      listen: "127.0.0.1:0",
      log: (l) => logs.push(l),
    });
    const pending = rpc(first, "fake", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "delete_page", arguments: { id: 9 } },
    });
    const hold = await until(async () => ((await api(first, "/api/holds")) as Obj[])[0]);
    await first.close();
    await pending.catch(() => undefined);
    const second = await boot("jsonl");
    const reloaded = (await api(second, "/api/holds")) as Obj[];
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ receipt: hold.receipt, orphaned: true, server: "fake" });
    expect(
      (await api(second, `/api/holds/${hold.receipt}/approve`, { method: "POST" })) as Obj,
    ).toMatchObject({ decided: true });
    const row = await until(async () =>
      (
        (await api(second, "/api/ledger?tail=10")) as {
          receipt: string;
          tool: string;
          status: string;
          held?: Obj;
        }[]
      ).find((r) => r.tool === "delete_page" && r.status === "executed"),
    );
    expect(row.receipt).toBe(hold.receipt);
    expect(row.held).toMatchObject({ decision: "approve" });
    expect(await api(second, "/api/holds")).toEqual([]);
    const third = openStores("jsonl", { log: (l) => logs.push(l) });
    expect(third.holds.pending()).toEqual([]);
  });

  it.skipIf(!sqliteAvailable())(
    "dead-letters, lists, replays and resolves through the API with SQLite storage",
    async () => {
      const d = await boot("sqlite");
      expect(((await api(d, "/api/health")) as Obj).ledger).toBe("sqlite");
      const dead = await rpc(d, "fake", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "strict", arguments: { limit: "10", tags: { nested: true } } },
      });
      expect(meta(dead.body)["sh.sayagain/status"]).toBe("dead-lettered");
      const receipt = String(meta(dead.body)["sh.sayagain/receipt"]);
      expect(
        ((await api(d, "/api/deadletters")) as { receipt: string; server?: string }[]).map((x) => [
          x.receipt,
          x.server,
        ]),
      ).toEqual([[receipt, "fake"]]);
      expect(
        (await api(d, `/api/replay/${receipt}`, { method: "POST", body: "{not json" })) as Obj,
      ).toMatchObject({ error: expect.stringContaining("JSON") });
      const outcome = (await api(d, `/api/replay/${receipt}`, {
        method: "POST",
        body: JSON.stringify({ arguments: { limit: 10, tags: "ok" } }),
      })) as { isError: boolean; replayOf: string };
      expect(outcome).toMatchObject({ isError: false, replayOf: receipt });
      expect(await api(d, "/api/deadletters")).toEqual([]);
      expect((await api(d, "/api/replay/nope", { method: "POST" })) as Obj).toMatchObject({
        error: expect.stringContaining("no dead letter"),
      });
    },
  );

  it("streams server notifications to the host's GET stream and control events to /api/events", async () => {
    const d = await boot();
    const init = await rpc(d, "fake", initMsg);
    const session = init.session ?? "";
    const seen: string[] = [];
    const events: string[] = [];
    const ctl = new AbortController();
    const stream = async (path: string, into: string[], headers: Record<string, string>) => {
      const res = await fetch(`${d.url}${path}`, {
        headers: { authorization: `Bearer ${d.token}`, accept: "text/event-stream", ...headers },
        signal: ctl.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        into.push(new TextDecoder().decode(value));
      }
    };
    void stream(`/mcp/fake`, seen, { "mcp-session-id": session });
    void stream(`/api/events?token=${d.token}`, events, { authorization: "Bearer nope" });
    await until(async () =>
      seen.join("").includes("connected") && events.join("").includes("connected")
        ? true
        : undefined,
    );
    const call = await rpc(
      d,
      "fake",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "notify", arguments: { text: "hey" } },
      },
      { session },
    );
    expect(meta(call.body)["sh.sayagain/status"]).toBe("executed");
    await until(async () => (seen.join("").includes("notifications/message") ? true : undefined));
    await until(async () => (events.join("").includes("event: row") ? true : undefined));
    expect(seen.join("")).toContain('"data":"hey"');
    ctl.abort();
  });

  it("drives the stdio shim end to end, including a request the server makes of the host", async () => {
    await boot();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Obj[] = [];
    let buf = "";
    output.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)) as Obj);
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
    input.write(`${JSON.stringify(initMsg)}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await until(async () => lines.find((m) => m.id === 1));
    input.write("this is not json\n");
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { via: "shim" } } })}\n`,
    );
    const reply = await until(async () => lines.find((m) => m.id === 2));
    expect(meta(reply)["sh.sayagain/receipt"]).toMatch(/^rcpt_/);
    // The server asks the host something (roots/list); the host answers on stdin; the tool result reports it.
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_client", arguments: { method: "roots/list" } } })}\n`,
    );
    const ask = await until(async () => lines.find((m) => m.method === "roots/list"));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { roots: [] } })}\n`);
    const answered = await until(async () => lines.find((m) => m.id === 3));
    expect(String(((answered.result as Obj).content as { text: string }[])[0]?.text)).toContain(
      '"answered":true',
    );
    input.end();
    expect(await run).toBe(0);
  });

  it("answers a server ping itself, restarts a crashed upstream on the next call, and fails non-tool requests when it dies", async () => {
    const d = await boot();
    const ping = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_client", arguments: { method: "ping" } },
    });
    expect(String(((ping.body.result as Obj).content as { text: string }[])[0]?.text)).toContain(
      '"answered":true',
    );
    const listWhileCrashing = rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const crash = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "crash", arguments: { code: 3 } },
    });
    expect(
      meta(crash.body)["sh.sayagain/status"] ??
        ((crash.body.error as Obj)?.data as Obj)?.["sh.sayagain/status"],
    ).toBe("dead-lettered");
    const list = await listWhileCrashing;
    expect(list.body.result !== undefined || (list.body.error as Obj)?.code === -32000).toBe(true);
    const again = await until(async () => {
      const r = await rpc(d, "fake", {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      });
      return meta(r.body)["sh.sayagain/status"] === "executed" ? r : undefined;
    }, 5000);
    expect(meta(again.body)["sh.sayagain/status"]).toBe("executed");
    expect(logs.some((l) => l.includes("closed: upstream exited"))).toBe(true);
  });

  it("serves the operator page with a strict CSP, takes the token on the query string for the page only, and answers the analysis routes", async () => {
    const d = await boot();
    const page = await fetch(`${d.url}/ui?token=${d.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/ui/app.js">');
    expect(html).toContain("0.4.0-test");
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // no remote origins
    const css = await fetch(`${d.url}/ui/app.css`); // assets need no token: tags cannot send headers
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const js = await fetch(`${d.url}/ui/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("sayagain.token");
    expect((await fetch(`${d.url}/ui`)).status).toBe(200); // the page is public: a reload has no token in its URL
    expect((await fetch(`${d.url}/ui/`)).status).toBe(200);
    // fetch drops a custom Host header (a forbidden header name), so the DNS-rebinding guard is checked over node:http.
    const rebound = await new Promise<number>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: d.port, path: "/ui", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end();
    });
    expect(rebound).toBe(421);
    expect((await fetch(`${d.url}/api/holds?token=${d.token}`)).status).toBe(401); // never for the API
    await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    });
    await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    const tools = (await api(d, "/api/tools?since=1h&minCalls=1")) as {
      tool: string;
      failureRatePct: number;
    }[];
    expect(tools.map((t) => t.tool)).toEqual(["missing", "echo"]);
    expect((await api(d, "/api/tools?since=1h&minCalls=1&server=fake")) as unknown[]).toHaveLength(
      2,
    ); // registry name
    expect((await api(d, "/api/tools?since=1h&minCalls=1&server=nope")) as unknown[]).toEqual([]);
    expect((await api(d, "/api/report?since=2999-01-01")) as { error: string }).toMatchObject({
      error: expect.stringContaining("past"),
    });
    const errors = (await api(d, "/api/errors?since=1h")) as { tool: string; errorClass: string }[];
    expect(errors).toMatchObject([{ tool: "missing", errorClass: "semantic" }]);
    const report = (await api(d, "/api/report?since=1h")) as {
      calls: number;
      byServer: { server: string }[];
    };
    expect(report.calls).toBe(2);
    expect(report.byServer[0]?.server).toBe("fake-notion");
    expect((await api(d, "/api/report?since=soon")) as { error: string }).toMatchObject({
      error: expect.stringContaining("duration"),
    });
  });
});
