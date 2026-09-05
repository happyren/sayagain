// A minimal stdio MCP server for tests: initialize, tools/list with annotations and schemas, tools/call.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let calls = 0;
const flaky = new Map(); // tool -> remaining failures
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
          { name: "strict_write", inputSchema: strictSchema },
          { name: "missing", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "slow_write", inputSchema: { type: "object" } },
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
    } else if (name === "strict" || name === "strict_write") {
      if (typeof args.limit !== "number") fail("Invalid params: limit must be a number");
      else if (args.tags !== undefined && typeof args.tags !== "string")
        fail("Invalid params: tags must be a string");
      else ok();
    } else if (name === "missing") {
      fail("Error: page 'zzz' not found");
    } else if (name === "slow_write") {
      setTimeout(ok, Number(args.delayMs ?? 200));
    } else ok();
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
rl.on("close", () => process.exit(0));
