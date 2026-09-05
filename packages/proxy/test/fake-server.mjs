// A minimal stdio MCP server for tests: initialize, tools/list with annotations, tools/call.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let calls = 0;

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
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    calls++;
    const args = msg.params?.arguments ?? {};
    if (args.rpcError) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "Invalid params: limit must be a number" },
      });
    } else if (args.fail) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Error: page 'abc-123' not found" }],
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ call: calls, tool: msg.params.name, args }) },
          ],
          _meta: { "example/upstream": true },
        },
      });
    }
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
rl.on("close", () => process.exit(0));
