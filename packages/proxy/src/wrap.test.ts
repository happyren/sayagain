import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MemoryLedger } from "./ledger.js";
import { wrap } from "./wrap.js";

const fixture = new URL("../test/fake-server.mjs", import.meta.url).pathname;

function harness() {
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
  return { input, ledger, wrapped, send, waitFor };
}

describe("wrap end to end", () => {
  it("passes identity through, stamps receipts, records the ledger", async () => {
    const h = harness();
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const init = (await h.waitFor(1)).result as Record<string, unknown>;
    expect(init.serverInfo).toEqual({ name: "fake-notion", version: "9.9.9" });
    expect(String(init.instructions)).toContain("Fake server instructions.");
    expect(String(init.instructions)).toContain("Say Again");
    expect((init._meta as Record<string, unknown>)["sh.sayagain/boundary"]).toMatchObject({
      upstream: "fake-notion",
    });

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = (await h.waitFor(2)).result as { tools: { name: string }[] };
    expect(list.tools[0]?.name).toBe("echo");

    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    const ok = (await h.waitFor(3)).result as Record<string, unknown>;
    expect((ok._meta as Record<string, unknown>)["example/upstream"]).toBe(true);
    expect((ok._meta as Record<string, unknown>)["sh.sayagain/status"]).toBe("executed");

    h.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: { fail: true } },
    });
    const failed = (await h.waitFor(4)).result as Record<string, unknown>;
    expect(failed.isError).toBe(true);
    expect((failed._meta as Record<string, unknown>)["sh.sayagain/receipt"]).toMatch(/^rcpt_/);

    h.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { rpcError: true } },
    });
    const rpcErr = await h.waitFor(5);
    expect(rpcErr.error).toBeDefined();

    h.send({ jsonrpc: "2.0", id: 6, method: "ping" });
    await h.waitFor(6);

    h.input.end();
    const code = await h.wrapped.done;
    expect(code).toBe(0);

    expect(h.ledger.rows.map((r) => [r.tool, r.isError, r.upstream])).toEqual([
      ["echo", false, "fake-notion"],
      ["echo", true, "fake-notion"],
      ["echo", true, "fake-notion"],
    ]);
    expect(h.ledger.rows[1]?.errorSignature).toBe("Error: page <str> not found");
    expect(h.ledger.rows[2]?.errorCode).toBe(-32602);
  });
});
