// A stdio MCP server that fails the way real ones do, and writes down what it actually did.
//
// The harness decides each agent step's fault (from a seed and the measured class mix) and names it
// in the call's `__fault` argument, so the server is a pure function of the call and its attempt
// count and the same fault meets both arms. A call that arrives without one, which is the boundary's
// own read-back or its re-send of a repaired call, draws its fault here from the same mix at the
// same rate, on the same seed (faults.mjs), so nothing that passes through the server is exempt.
// The classes are the boundary's own (errors.ts), at the shares the 30-day audit measured on this
// machine's MCP traffic:
//   other      45%  an error nothing downstream can class or act on; persists on retry
//   semantic   26%  a precondition that does not hold (the harness aims at a missing record)
//   retryable  18%  a timeout that a second attempt survives
//   blocked     6%  a permission the caller lacks; persists on retry
//   coercible   5%  an argument of the wrong type (the harness sends a string for a number)
// plus `lost`, a write that lands and loses its answer once, at about the rate M9 was measured
// (one write in a hundred), which is the case the north-star metric counts.
//
// The truth log records every side effect that really happened, so the harness can compare what the
// agent believes against what the world did. FAULT_TRUTH and FAULT_CALLS name the two logs;
// FAULT_SEED, FAULT_RATE and FAULT_MIX are the draw for calls that carry no fault of their own.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { faultFor, settingsFromEnv } from "./faults.mjs";

const truthPath = process.env.FAULT_TRUTH;
const callsPath = process.env.FAULT_CALLS;
const settings = settingsFromEnv(process.env);

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const records = new Map(); // id -> { status }
const attempts = new Map(); // step key -> how many times a call for it has arrived

const remember = (effect) => {
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
const VERIFY = (effect) => ({
  "sh.sayagain/verify": { tool: "get_record", arguments: { id: "$arguments.id" }, effect },
});

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
    _meta: VERIFY("result"),
  },
  {
    name: "delete_record",
    description: "Delete a record and everything under it.",
    inputSchema: RECORD_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: VERIFY("absence"),
  },
];
const WRITES = new Set(["set_status", "create_record", "delete_record"]);

const handleCall = (id, name, args) => {
  // Every call the server really ran, whoever sent it: the honest denominator for the failure tax.
  if (callsPath) appendFileSync(callsPath, `${name}\n`);
  const key = args?.__step ?? `${name}:${JSON.stringify(args ?? {})}`;
  const n = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, n);
  // An agent step's fault is drawn on the step, so its retry meets the second attempt of the same
  // fault; a call without one draws per attempt, so its fault is already this attempt's.
  const own = args?.__fault === undefined;
  const fault = own ? faultFor(settings, key, n) : args.__fault;

  // Server-side faults that do not depend on what the call asked for.
  if (fault === "other") return fail(id, "Error: internal error (see server logs)");
  if (fault === "blocked") return fail(id, "permission denied for this operation");
  if (fault === "retryable" && (own || n === 1)) return fail(id, "Request timed out after 30000ms");

  // Agent-side: an argument of the wrong type. The schema says a number; a string arrives.
  if (args && typeof args.limit === "string")
    return fail(id, "Invalid params: limit must be a number, got string");

  // Agent-side: a precondition that does not hold yet.
  if ((name === "get_record" || name === "set_status" || name === "delete_record") && args?.id) {
    if (!records.has(args.id)) return fail(id, `record ${args.id} not found`);
  }

  if (name === "search_records") return ok(id, `matched 3 records for ${args?.query ?? ""}`);
  if (name === "get_record") return ok(id, `record ${args.id} is ${records.get(args.id).status}`);

  if (name === "create_record") {
    records.set(args.id, { status: "new" });
    remember({ effect: "create", id: args.id, attempt: n });
  } else if (name === "set_status") {
    records.set(args.id, { status: args.status ?? "done" });
    remember({
      effect: "set_status",
      id: args.id,
      status: args.status ?? "done",
      attempt: n,
      idempotent: true,
    });
  } else if (name === "delete_record") {
    records.delete(args.id);
    remember({ effect: "delete", id: args.id, attempt: n });
  }

  // A write that lands and then loses its answer, once. The world changed; the agent is told it
  // failed; a second attempt answers, and lands again if nothing checked first.
  if (fault === "lost" && WRITES.has(name) && n === 1)
    return fail(id, "Request timed out after 30000ms");
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
        serverInfo: { name: "fault-records", version: "2.1.0" },
      },
    });
  if (msg.method === "tools/list")
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call")
    return handleCall(msg.id, msg.params?.name, msg.params?.arguments ?? {});
  if (msg.id !== undefined)
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
});
