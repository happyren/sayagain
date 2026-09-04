import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MemoryLedger } from "./ledger.js";
import { wrap } from "./wrap.js";

const fixture = new URL("../test/fake-server.mjs", import.meta.url).pathname;

function harness(policy: Parameters<typeof wrap>[0]["policy"] = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const ledger = new MemoryLedger();
  const lines: string[] = [];
  let buf = "";
  output.on("data", (c: Buffer) => {
    buf += c.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  });
  const wrapped = wrap({
    command: process.execPath,
    args: [fixture],
    input,
    output,
    ledger,
    announce: true,
    control: false,
    policy,
    holdTtlMs: 200,
  });
  const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
  const waitFor = (id: unknown, timeoutMs = 5000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((m) => m.id === id);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > timeoutMs)
          return reject(new Error(`no response for id ${String(id)}`));
        setTimeout(tick, 10);
      };
      tick();
    });
  const handshake = async () => {
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await waitFor("init");
    send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    await waitFor("list");
  };
  const finish = async () => {
    input.end();
    return wrapped.done;
  };
  const call = (id: unknown, name: string, args: unknown, meta?: Record<string, unknown>) => {
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) params._meta = meta;
    send({ jsonrpc: "2.0", id, method: "tools/call", params });
  };
  return { ledger, wrapped, send, waitFor, handshake, finish, call };
}

const meta = (m: Record<string, unknown>) => (m.result as { _meta: Record<string, unknown> })._meta;

describe("wrap end to end", () => {
  it("passes identity through and stamps receipts", async () => {
    const h = harness();
    await h.handshake();
    h.call(3, "echo", { a: 1 });
    const ok = await h.waitFor(3);
    expect(meta(ok)["example/upstream"]).toBe(true);
    expect(meta(ok)["sh.sayagain/status"]).toBe("executed");
    h.call(4, "echo", { fail: true });
    expect((await h.waitFor(4)).result).toMatchObject({ isError: true });
    h.call(5, "echo", { rpcError: true });
    expect((await h.waitFor(5)).error).toBeDefined();
    h.send({ jsonrpc: "2.0", id: 6, method: "ping" });
    await h.waitFor(6);
    expect(await h.finish()).toBe(0);
    expect(h.ledger.rows.map((r) => [r.tool, r.toolClass, r.isError])).toEqual([
      ["echo", "read-only", false],
      ["echo", "read-only", true],
      ["echo", "read-only", true],
    ]);
  });

  it("DISREGARD: repeats of a write are answered from the first result; reads are not", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "create_page", { title: "x" });
    const first = await h.waitFor(1);
    h.call(2, "create_page", { title: "x" });
    const second = await h.waitFor(2);
    expect(meta(second)["sh.sayagain/status"]).toBe("deduplicated");
    expect(meta(second)["sh.sayagain/duplicate-of"]).toBe(meta(first)["sh.sayagain/receipt"]);
    expect((second.result as { content: { text: string }[] }).content[0]?.text).toBe(
      (first.result as { content: { text: string }[] }).content[0]?.text,
    );
    h.call(3, "echo", { a: 1 });
    await h.waitFor(3);
    h.call(4, "echo", { a: 1 });
    expect(meta(await h.waitFor(4))["sh.sayagain/status"]).toBe("executed");
    h.call(5, "echo", { a: 2 }, { "sh.sayagain/idempotency-key": "K" });
    await h.waitFor(5);
    h.call(6, "echo", { a: 3 }, { "sh.sayagain/idempotency-key": "K" });
    expect(meta(await h.waitFor(6))["sh.sayagain/status"]).toBe("deduplicated");
    await h.finish();
    expect(h.ledger.rows.filter((r) => r.status === "deduplicated")).toHaveLength(2);
  });

  it("STANDBY: a destructive call waits, executes once on approve", async () => {
    const h = harness({ holdWaitMs: 2000 });
    await h.handshake();
    h.call(1, "delete_page", { id: 42 }, { "sh.sayagain/intent": "remove the draft" });
    await new Promise((r) => setTimeout(r, 50));
    const pending = h.wrapped.holds.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool: "delete_page",
      intent: "remove the draft",
      arguments: { id: 42 },
    });
    expect(h.wrapped.holds.decide(pending[0]?.receipt ?? "", "approve")).toBe(true);
    const done = await h.waitFor(1);
    expect(meta(done)["sh.sayagain/status"]).toBe("executed");
    expect(meta(done)["sh.sayagain/held"]).toEqual({
      reason: "tool is classified destructive",
      decision: "approve",
    });
    await h.finish();
    expect(h.ledger.rows[0]).toMatchObject({
      tool: "delete_page",
      toolClass: "destructive",
      status: "executed",
      held: { decision: "approve" },
    });
  });

  it("STANDBY: a rejected call is answered UNABLE; an unanswered hold reports STANDBY after the wait", async () => {
    const h = harness({ holdWaitMs: 100 });
    await h.handshake();
    h.call(1, "delete_page", { id: 1 });
    await new Promise((r) => setTimeout(r, 30));
    h.wrapped.holds.decide(h.wrapped.holds.list()[0]?.receipt ?? "", "reject");
    const rejected = await h.waitFor(1);
    expect((rejected.result as { isError: boolean }).isError).toBe(true);
    expect(meta(rejected)["sh.sayagain/status"]).toBe("held");
    h.call(2, "delete_page", { id: 2 });
    const held = await h.waitFor(2);
    expect(
      (held.result as { isError: boolean; content: { text: string }[] }).content[0]?.text,
    ).toContain("STANDBY");
    expect(h.wrapped.holds.list()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.wrapped.holds.list()).toHaveLength(0);
    await h.finish();
    expect(h.ledger.rows.map((r) => r.status)).toEqual(["held", "held"]);
  });
});

describe("classifier warm-up", () => {
  it("holds a destructive call that arrives before the client ever asked for tools/list", async () => {
    const h = harness({ holdWaitMs: 300 });
    h.send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await h.waitFor("init");
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.call(1, "delete_page", { id: 7 });
    const held = await h.waitFor(1);
    expect(meta(held)["sh.sayagain/status"]).toBe("held");
    expect(h.wrapped.classifier.warm).toBe(true);
    await h.finish();
    expect(h.ledger.rows[0]).toMatchObject({
      tool: "delete_page",
      toolClass: "destructive",
      status: "held",
    });
  });
});
