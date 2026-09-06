// A minimal stdio MCP server for tests: initialize, tools/list with annotations and schemas, tools/call.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let calls = 0;
const flaky = new Map(); // tool -> remaining failures
const landed = new Set(); // ids whose lost_write really executed
const lostOnce = new Set(); // keys that have already lost one answer
const VERIFY = { "sh.sayagain/verify": { tool: "landed", arguments: { id: "$arguments.id" } } };
const asks = new Map(); // id -> resolver for a request the server made of the client
const strictSchema = {
  type: "object",
  properties: { limit: { type: "number" }, tags: { type: "string" }, title: { type: "string" } },
  required: ["limit"],
};

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2026-07-28",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-notion", version: "9.9.9" },
        instructions: "Fake server instructions.",
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "create_page", inputSchema: { type: "object" } },
          {
            name: "delete_page",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true },
          },
          { name: "flaky", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "write_flaky", inputSchema: { type: "object" } },
          { name: "strict", inputSchema: strictSchema, annotations: { readOnlyHint: true } },
          { name: "loose", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "strict_write", inputSchema: strictSchema },
          { name: "missing", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "slow_write", inputSchema: { type: "object" } },
          { name: "notify", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          {
            name: "ask_client",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
          { name: "crash", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          // A write that lands and then loses its answer, and one that loses its answer without
          // landing; both say how to read the effect back (spec 8.3).
          { name: "lost_write", inputSchema: { type: "object" }, _meta: VERIFY },
          { name: "vanished_write", inputSchema: { type: "object" }, _meta: VERIFY },
          { name: "landed", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          {
            name: "unverifiable_write",
            inputSchema: { type: "object" },
            _meta: {
              "sh.sayagain/verify": { tool: "create_page", arguments: { id: "$arguments.id" } },
            },
          },
          // A destructive write verified by absence: after it, the record must be gone.
          {
            name: "lost_delete",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true },
            _meta: {
              "sh.sayagain/verify": {
                tool: "landed",
                arguments: { id: "$arguments.id" },
                effect: "absence",
              },
            },
          },
          // A verifier that cannot answer yet: its failure says nothing about the write.
          {
            name: "unready_write",
            inputSchema: { type: "object" },
            _meta: {
              "sh.sayagain/verify": { tool: "unready", arguments: { id: "$arguments.id" } },
            },
          },
          { name: "unready", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          // A declaration the boundary cannot resolve: the template refers to a result.
          {
            name: "badtemplate_write",
            inputSchema: { type: "object" },
            _meta: { "sh.sayagain/verify": { tool: "landed", arguments: { id: "$result.id" } } },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    calls++;
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const fail = (text) =>
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { isError: true, content: [{ type: "text", text }] },
      });
    const ok = () =>
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ call: calls, tool: name, args }) }],
          _meta: { "example/upstream": true },
        },
      });
    if (args.rpcError) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "Invalid params: limit must be a number" },
      });
    } else if (args.rpcErrorNoMessage) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000 } });
    } else if (args.fail) {
      fail("Error: page 'abc-123' not found");
    } else if (name === "flaky" || name === "write_flaky") {
      if (!flaky.has(name)) flaky.set(name, Number(args.failTimes ?? 0));
      const left = flaky.get(name);
      if (left > 0) {
        flaky.set(name, left - 1);
        fail("Error: Request timed out");
      } else ok();
    } else if (name === "strict" || name === "strict_write" || name === "loose") {
      if (typeof args.limit !== "number") fail("Invalid params: limit must be a number");
      else if (args.tags !== undefined && typeof args.tags !== "string")
        fail("Invalid params: tags must be a string");
      else ok();
    } else if (name === "missing") {
      fail("Error: page 'zzz' not found");
    } else if (name === "slow_write") {
      setTimeout(ok, Number(args.delayMs ?? 200));
    } else if (name === "notify") {
      // A server-initiated notification before the result.
      send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: args.text ?? "hello" },
      });
      ok();
    } else if (name === "ask_client") {
      // A server-initiated request: the result reports what the client answered.
      const id = `ask-${calls}`;
      const timer = setTimeout(
        () => {
          asks.delete(id);
          fail("Error: client did not answer the ping");
        },
        Number(args.timeoutMs ?? 2000),
      );
      asks.set(id, (reply) => {
        clearTimeout(timer);
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ answered: !reply.error, reply }) }],
          },
        });
      });
      send({ jsonrpc: "2.0", id, method: args.method ?? "ping", params: {} });
    } else if (name === "crash") {
      process.exit(Number(args.code ?? 3));
    } else if (
      name === "lost_write" ||
      name === "vanished_write" ||
      name === "unverifiable_write" ||
      name === "unready_write" ||
      name === "badtemplate_write"
    ) {
      const key = `${name}:${args.id}`;
      if (!lostOnce.has(key)) {
        lostOnce.add(key);
        if (name !== "vanished_write") landed.add(args.id); // it happened; the answer is what is lost
        fail("Error: Request timed out");
      } else {
        landed.add(args.id);
        ok();
      }
    } else if (name === "lost_delete") {
      const key = `${name}:${args.id}`;
      landed.delete(args.id); // the deletion happens either way
      if (!lostOnce.has(key)) {
        lostOnce.add(key);
        fail("Error: Request timed out");
      } else ok();
    } else if (name === "unready") {
      fail("Error: Client not initialized. Call initialize first."); // semantic, but not an absence
    } else if (name === "landed") {
      if (landed.has(args.id)) ok();
      else fail(`Error: record '${args.id}' not found`);
    } else ok();
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === undefined && msg.id !== undefined && asks.has(msg.id)) {
    asks.get(msg.id)(msg);
    asks.delete(msg.id);
  }
});
rl.on("close", () => process.exit(0));
