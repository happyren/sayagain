import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickArm } from "./boundary.js";
import { type Daemon, startDaemon } from "./daemon.js";
import { LearnedStore } from "./learned.js";
import { saveRegistry } from "./registry.js";
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

  it("serves the overview: the mode, every server with its window, and the doctor's findings", async () => {
    const d = await boot("memory", {
      registry: {
        servers: { fake: { transport: "stdio", command: process.execPath, args: [fixture] } },
        daemon: { hold: "never" },
      },
    });
    const init = await rpc(d, "fake", initMsg);
    await rpc(
      d,
      "fake",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { a: 1 } },
      },
      init.session ? { session: init.session } : {},
    );
    const o = (await api(d, "/api/overview")) as {
      daemon: { hold: string; version: string; startedAt: string };
      servers: {
        name: string;
        started: boolean;
        ready: boolean;
        calls: number;
        failures: number;
      }[];
      calls: number;
      doctor: { severity: string; title: string; fix?: string }[];
    };
    expect(o.daemon).toMatchObject({ hold: "never", version: "0.4.0-test" });
    expect(Date.parse(o.daemon.startedAt)).toBeGreaterThan(0);
    expect(o.servers).toEqual([
      expect.objectContaining({ name: "fake", started: true, ready: true, calls: 1, failures: 0 }),
    ]);
    expect(o.calls).toBe(1);
    expect(o.doctor.find((f) => f.title.includes("holds are off"))).toMatchObject({
      severity: "note",
      fix: "sayagain up --hold",
    });
  });

  it("keeps the daemon-level hold default when the page or status re-reads the registry", async () => {
    // `sayagain up` writes daemon.hold: never; the page's own /api/servers call re-reads the file
    // and must not put every boundary back on hold-by-default while the page says holds are off.
    const registry = {
      servers: {
        fake: { transport: "stdio" as const, command: process.execPath, args: [fixture] },
      },
      daemon: { hold: "never" as const },
    };
    saveRegistry(registry);
    const d = await boot("memory", { registry });
    const before = await rpc(d, "fake", initMsg);
    expect(meta(before.body)["sh.sayagain/boundary"]).toMatchObject({ hold: "never" });
    expect(((await api(d, "/api/health")) as Obj).hold).toBe("never");
    await api(d, "/api/servers");
    await api(d, "/api/policy/reload", { method: "POST" });
    const after = await rpc(d, "fake", initMsg);
    expect(meta(after.body)["sh.sayagain/boundary"]).toMatchObject({ hold: "never" });
    // Turning holds on is a change to the file, picked up by the same re-read.
    saveRegistry({ ...registry, daemon: { hold: "destructive" } });
    await api(d, "/api/servers");
    const on = await rpc(d, "fake", initMsg);
    expect(meta(on.body)["sh.sayagain/boundary"]).toMatchObject({ hold: "destructive" });
    expect(((await api(d, "/api/health")) as Obj).hold).toBe("destructive");
  });

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

  it("applies a changed class table to a running boundary without restarting the upstream", async () => {
    const d = await boot();
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "delete_page", arguments: { id } },
    });
    // As shipped: the fixture annotates delete_page destructive, so the call waits for a decision.
    const held = rpc(d, "fake", call(1));
    const hold = await until(async () => ((await api(d, "/api/holds")) as Obj[])[0]);
    await api(d, `/api/holds/${hold.receipt}/approve`, { method: "POST" });
    await held;
    const before = (await api(d, "/api/servers")) as { started: boolean }[];
    expect(before[0]?.started).toBe(true);

    // The operator disagrees and writes it down; the daemon picks it up on its own.
    saveRegistry({
      servers: {
        fake: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture],
          hold: "destructive",
          classes: { delete_page: "idempotent-write" },
        },
      },
    });
    const reloaded = (await api(d, "/api/policy/reload", { method: "POST" })) as {
      servers: number;
    };
    expect(reloaded.servers).toBe(1);
    const straight = await rpc(d, "fake", call(2));
    expect(straight.status).toBe(200);
    expect((await api(d, "/api/holds")) as Obj[]).toHaveLength(0); // nothing waiting this time
    const rows = (await api(d, "/api/ledger?tail=1")) as {
      tool: string;
      toolClass: string;
      held?: unknown;
    }[];
    expect(rows[0]).toMatchObject({ tool: "delete_page", toolClass: "idempotent-write" });
    expect(rows[0]?.held).toBeUndefined();
    const after = (await api(d, "/api/servers")) as { started: boolean; upstream: string | null }[];
    expect(after[0]).toMatchObject({ started: true, upstream: "fake-notion" }); // same upstream throughout

    // The other direction: raising a safe tool mid-session starts holding it.
    saveRegistry({
      servers: {
        fake: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture],
          hold: "destructive",
          classes: { echo: "destructive" },
        },
      },
    });
    expect(
      ((await api(d, "/api/policy/reload", { method: "POST" })) as { servers: number }).servers,
    ).toBe(1);
    const raised = rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    const now = await until(async () => ((await api(d, "/api/holds")) as Obj[])[0]);
    expect(now).toMatchObject({ tool: "echo" }); // a read the operator called destructive
    await api(d, `/api/holds/${now.receipt}/approve`, { method: "POST" });
    await raised;
    expect(logs.some((l) => l.includes("policy reloaded"))).toBe(true);
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

  it("assigns every host session an arm and stamps it on the rows", {
    timeout: 15_000,
  }, async () => {
    const d = await boot("memory", { arm: "control" });
    expect(await api(d, "/api/health")).toMatchObject({ arm: "control" });
    const session = (await rpc(d, "fake", initMsg)).session ?? "";
    expect(session).not.toBe("");
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "delete_page", arguments: { id: `p${id}` } },
    });
    const inSession = await rpc(d, "fake", call(2), { session });
    expect(inSession.status).toBe(200);
    const sessionless = await rpc(d, "fake", call(3)); // some hosts never send a session id
    expect(sessionless.status).toBe(200);
    const rows = (await api(d, "/api/ledger?tail=2")) as {
      arm?: string;
      status: string;
      held?: unknown;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ arm: "control", status: "executed" }); // not held in control
      expect(row.held).toBeUndefined();
    }
    expect(logs.some((l) => l.includes("in the control arm (control)"))).toBe(true);
  });

  it("reports the arm mode on health, none outside an experiment, and picks arms deterministically by day", {
    timeout: 15_000,
  }, async () => {
    const daily = await boot("memory", { arm: "daily" });
    expect(await api(daily, "/api/health")).toMatchObject({ arm: "daily" });
    expect(["control", "treatment"]).toContain(pickArm("daily"));
    expect(pickArm("daily", new Date("2026-09-06T00:00:00Z"))).toBe(
      pickArm("daily", new Date("2026-09-06T23:59:59Z")),
    );
    const arms = new Set(
      Array.from({ length: 31 }, (_, i) => pickArm("daily", new Date(Date.UTC(2026, 8, 1 + i)))),
    );
    expect(arms.size).toBe(2); // a month lands in both arms
    expect(pickArm("control")).toBe("control");
    expect(pickArm("treatment")).toBe("treatment");
    expect(["control", "treatment"]).toContain(pickArm("coinflip"));
    await daily.close();
    const plain = await boot("memory");
    expect(await api(plain, "/api/health")).toMatchObject({ arm: null });
  });

  it("pins the treatment arm, keeps one arm per session under coinflip, and gives sessionless calls one arm for the daemon's lifetime", {
    timeout: 15_000,
  }, async () => {
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo", arguments: { id } },
    });
    const pinned = await boot("memory", { arm: "treatment" });
    expect(await api(pinned, "/api/health")).toMatchObject({ arm: "treatment" });
    const pinnedSession = (await rpc(pinned, "fake", initMsg)).session ?? "";
    expect((await rpc(pinned, "fake", call(2), { session: pinnedSession })).status).toBe(200);
    const [pinnedRow] = (await api(pinned, "/api/ledger?tail=1")) as { arm?: string }[];
    expect(pinnedRow?.arm).toBe("treatment"); // a pinned treatment run is inside the experiment
    await pinned.close();

    const flip = await boot("memory", { arm: "coinflip" });
    const session = (await rpc(flip, "fake", initMsg)).session ?? "";
    for (const id of [2, 3, 4])
      expect((await rpc(flip, "fake", call(id), { session })).status).toBe(200);
    for (const id of [5, 6, 7]) expect((await rpc(flip, "fake", call(id))).status).toBe(200);
    const rows = (await api(flip, "/api/ledger?tail=6")) as { arm?: string; session?: string }[];
    expect(rows).toHaveLength(6);
    const inSession = rows.filter((r) => r.session === session);
    const sessionless = rows.filter((r) => r.session !== session);
    expect(inSession).toHaveLength(3);
    expect(sessionless).toHaveLength(3);
    expect(new Set(inSession.map((r) => r.arm)).size).toBe(1); // one coin per session
    expect(new Set(sessionless.map((r) => r.arm)).size).toBe(1); // one coin per daemon for sessionless calls
    expect(rows.every((r) => r.arm === "control" || r.arm === "treatment")).toBe(true);
    expect(logs.some((l) => l.includes("calls without a session id run in the"))).toBe(true);
    await flip.close();
  });

  it("applies a learned coercion before a safe call leaves, augments tools/list, hints on a known failure, and obeys revert", async () => {
    const seeded = {
      version: 1,
      updatedAt: new Date().toISOString(),
      interventions: [
        {
          id: "coerce:fake/strict/limit:string-number",
          kind: "coerce",
          mode: "apply",
          server: "fake",
          tool: "strict",
          signature: "Invalid params: limit must be a number",
          errorClass: "coercible",
          path: "/limit",
          from: "string",
          to: "number",
          rule: "string-to-number",
          fact: "`limit` is a number, not a string.",
          errorHint:
            "Say Again: last time this failed it was fixed by passing `limit` as a number instead of a string.",
          evidence: 3,
          learnedAt: new Date().toISOString(),
          activatedAt: new Date().toISOString(),
          state: "active",
        },
        {
          id: "hint:fake/missing:precondition:x",
          kind: "hint",
          server: "fake",
          tool: "missing",
          signature: "Error: page <str> not found",
          errorClass: "semantic",
          fact: "Call `echo` first; `missing` fails otherwise.",
          errorHint: "Say Again: last time this was fixed by calling `echo` first.",
          evidence: 3,
          learnedAt: new Date().toISOString(),
          activatedAt: new Date().toISOString(),
          state: "active",
        },
      ],
    };
    writeFileSync(join(home, "learned.json"), JSON.stringify(seeded));
    const d = await boot("memory", {
      learned: new LearnedStore(join(home, "learned.json")),
      learnEveryMs: 3_600_000,
    });
    const call = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "strict", arguments: { limit: "10" } },
    });
    const m = meta(call.body);
    expect(m["sh.sayagain/status"]).toBe("repaired");
    expect(m["sh.sayagain/repair"]).toMatchObject({
      changes: [{ path: "/limit", rule: "learned:string-to-number" }],
    });
    expect(JSON.stringify(m["sh.sayagain/repair"])).not.toContain("via");
    expect((call.body.result as Obj).isError).toBeUndefined();
    const rows = (await api(d, "/api/ledger?tail=1")) as {
      status: string;
      attempts?: number;
      repairs?: { rule: string }[];
    }[];
    expect(rows[0]).toMatchObject({
      status: "repaired",
      repairs: [{ rule: "learned:string-to-number" }],
    });
    expect(rows[0]?.attempts).toBeUndefined(); // one attempt: the failure never happened
    const list = await rpc(d, "fake", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list.body.result as Obj).tools as { name: string; description?: string }[];
    expect(tools.find((t) => t.name === "strict")?.description).toBe(
      "[Say Again learned] `limit` is a number, not a string.",
    );
    expect(tools.find((t) => t.name === "echo")?.description).toBeUndefined();
    const missing = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    });
    const text = ((missing.body.result as Obj).content as { text: string }[])
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("Say Again: last time this was fixed by calling `echo` first.");
    expect(
      ((await api(d, "/api/learn")) as { interventions: unknown[] }).interventions,
    ).toHaveLength(2);
    expect(
      (await api(d, "/api/learn/coerce%3Afake%2Fstrict%2Flimit%3Astring-number/revert", {
        method: "POST",
      })) as Obj,
    ).toMatchObject({ state: "disabled" });
    const after = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "strict", arguments: { limit: "10" } },
    });
    expect(meta(after.body)["sh.sayagain/status"]).toBe("repaired"); // the schema repair still catches it, after a failure
    expect(meta(after.body)["sh.sayagain/repair"]).toMatchObject({
      changes: [{ rule: "string-to-number" }],
    });
    expect((await api(d, "/api/learn/nope/enable", { method: "POST" })) as Obj).toMatchObject({
      error: expect.stringContaining("no intervention"),
    });
    // Back on, but advising: the loop's default. The call fails first and the schema repairs it.
    const id = encodeURIComponent("coerce:fake/strict/limit:string-number");
    expect((await api(d, `/api/learn/${id}/enable`, { method: "POST" })) as Obj).toMatchObject({
      state: "active",
    });
    expect((await api(d, `/api/learn/${id}/advise`, { method: "POST" })) as Obj).toMatchObject({
      mode: "advise",
    });
    const advised = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "strict", arguments: { limit: "10" } },
    });
    expect(meta(advised.body)["sh.sayagain/status"]).toBe("repaired");
    expect(meta(advised.body)["sh.sayagain/repair"]).toMatchObject({
      changes: [{ rule: "string-to-number" }],
    });
    expect((await api(d, `/api/learn/${id}/apply`, { method: "POST" })) as Obj).toMatchObject({
      mode: "apply",
    });
    const applied = await rpc(d, "fake", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "strict", arguments: { limit: "10" } },
    });
    expect(meta(applied.body)["sh.sayagain/repair"]).toMatchObject({
      changes: [{ rule: "learned:string-to-number" }],
    });
    expect((await api(d, "/api/learn/nope/apply", { method: "POST" })) as Obj).toMatchObject({
      error: expect.stringContaining("no coercion"),
    });
    const hintId = encodeURIComponent("hint:fake/missing:precondition:x");
    expect((await api(d, `/api/learn/${hintId}/apply`, { method: "POST" })) as Obj).toMatchObject({
      error: expect.stringContaining("no coercion"), // hints have no mode
    });
    const report = await (
      await fetch(`${d.url}/api/learn/report/fake`, {
        headers: { authorization: `Bearer ${d.token}` },
      })
    ).text();
    expect(report).toContain("# Tool definition report: fake");
  });
});
