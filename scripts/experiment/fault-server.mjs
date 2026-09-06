// A stdio MCP server that fails the way real ones do, on a seed, and writes down what it actually did.
//
// Two kinds of failure reach an agent, and the boundary answers them differently:
//   server-side, drawn from the seed  - a call that times out and would work on a retry, and a write
//                                       that executes and then loses its answer (the M9 case)
//   agent-side, carried in the call   - an argument of the wrong type, and a call whose precondition
//                                       does not hold yet
// The truth log is the point of the whole file: it records every side effect that really happened,
// so the harness can compare what the agent believes against what the world did.
//
// Environment: FAULT_SEED, FAULT_TRUTH (path), FAULT_FLAKY, FAULT_LOST (rates, 0 to 1).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const seedText = process.env.FAULT_SEED ?? "0";
const truthPath = process.env.FAULT_TRUTH;
const callsPath = process.env.FAULT_CALLS;
const flakyRate = Number(process.env.FAULT_FLAKY ?? "0.06");
const lostRate = Number(process.env.FAULT_LOST ?? "0.03");

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * A stable 32-bit hash, so a key always draws the same fault for a given seed. The final mix is not
 * decoration: without it two keys differing in one character land within a thousandth of each
 * other, and every step of a task draws nearly the same number, so faults arrive in clumps.
 */
const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
};
/** A number in [0,1) from a key: the fault draw, fixed for the life of a run. */
const draw = (key) => hash(`${seedText}:${key}`) / 4294967296;

const records = new Map(); // id -> { status }
const attempts = new Map(); // key -> how many times this exact call has arrived
const executed = []; // every side effect that really happened

const remember = (effect) => {
  executed.push(effect);
  if (truthPath) appendFileSync(truthPath, `${JSON.stringify(effect)}\n`);
};

const ok = (id, text) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const fail = (id, text) =>
  send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });

const RECORD_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, limit: { type: "number" }, status: { type: "string" } },
  required: ["id"],
};

const TOOLS = [
  {
    name: "search_records",
    description: "Search the records and return the matches.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_record",
    description: "Return one record by id.",
    inputSchema: RECORD_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "set_status",
    description: "Set a record's status. Setting it twice leaves the same status.",
    inputSchema: RECORD_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "create_record",
    description: "Create a record.",
    inputSchema: RECORD_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    // Spec 8.3: a boundary may read the effect back before re-sending a call whose answer was lost.
    _meta: { "sh.sayagain/verify": { tool: "get_record", arguments: { id: "$arguments.id" } } },
  },
  {
    name: "delete_record",
    description: "Delete a record and everything under it.",
    inputSchema: RECORD_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: {
      "sh.sayagain/verify": {
        tool: "get_record",
        arguments: { id: "$arguments.id" },
        effect: "absence",
      },
    },
  },
];
const WRITES = new Set(["set_status", "create_record", "delete_record"]);

const handleCall = (id, name, args) => {
  // Every call the server really ran, whoever sent it: the honest denominator for a claim about
  // the failure tax, since a boundary that retries has not removed the work, it has moved it.
  if (callsPath) appendFileSync(callsPath, `${name}\n`);
  // The fault is drawn on the logical step the caller names, not on the argument bytes, so a repair
  // or a retry by either side meets the same fault. Without this the arms face different draws.
  const key = args?.__step ? `step:${args.__step}` : `${name}:${JSON.stringify(args ?? {})}`;
  const n = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, n);

  // Agent-side: an argument of the wrong type. The schema says a number; a string arrives.
  if (args && typeof args.limit === "string")
    return fail(id, `Invalid params: limit must be a number, got string`);

  // Agent-side: a precondition that does not hold yet.
  if ((name === "get_record" || name === "set_status" || name === "delete_record") && args?.id) {
    if (!records.has(args.id)) return fail(id, `record ${args.id} not found`);
  }

  // Server-side, on the seed: a call that fails the first time and works on a retry.
  const flaky = draw(`flaky:${key}`) < flakyRate;
  if (flaky && n === 1) return fail(id, "Request timed out after 30000ms");

  // Server-side, on the seed: a write that lands and then loses its answer, once. The world changed;
  // the agent is told it failed; a second attempt answers. This is the case the north-star metric
  // counts. Losing every attempt would be an outage, not a lost answer, and would make any arm that
  // retries look worse than one that does not.
  const lost = WRITES.has(name) && n === 1 && draw(`lost:${key}`) < lostRate;

  if (name === "search_records") return ok(id, `matched 3 records for ${args?.query ?? ""}`);
  if (name === "get_record") return ok(id, `record ${args.id} is ${records.get(args.id).status}`);

  if (name === "create_record") {
    records.set(args.id, { status: "new" });
    remember({ effect: "create", id: args.id, attempt: n });
  } else if (name === "set_status") {
    records.set(args.id, { status: args.status ?? "done" });
    remember({ effect: "set_status", id: args.id, status: args.status ?? "done", attempt: n });
  } else if (name === "delete_record") {
    records.delete(args.id);
    remember({ effect: "delete", id: args.id, attempt: n });
  }

  if (lost) return fail(id, "Request timed out after 30000ms");
  return ok(id, `${name} ok for ${args?.id ?? ""}`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2026-07-28",
        capabilities: { tools: {} },
        serverInfo: { name: "fault-records", version: "1.0.0" },
      },
    });
  if (msg.method === "tools/list")
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call")
    return handleCall(msg.id, msg.params?.name, msg.params?.arguments ?? {});
  if (msg.id !== undefined)
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
});
