// A transport-level fault injector for any stdio MCP server (docs/measurement.md 5.6).
//
// The fault server fails from the inside; this fails from the outside, so the same harness can run
// against a real server: it spawns the command in CHAOS_SERVER, forwards JSON-RPC lines both ways,
// and acts on the `__fault` and `__step` arguments the harness puts on each call, stripping both
// before the server sees them. What it can do to a call from outside:
//   retryable  answer a timeout once, without forwarding; the second attempt goes through
//   other      answer an unclassifiable error every time, without forwarding
//   blocked    answer a permission error every time, without forwarding
//   lost       forward the call, drop the server's answer, answer a timeout instead, once
// It logs every call it forwarded (FAULT_CALLS) and, for calls to tools the server does not mark
// read-only, a truth entry (FAULT_TRUTH) when the server answered without an error. That is what
// "the write happened" means from the transport: the request was delivered and the server said
// it did the work. A server that did the work and then failed is the lost case, which the shim
// makes itself by dropping a good answer; a server that lied is beyond any transport's sight.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const command = process.env.CHAOS_SERVER;
if (!command) {
  process.stderr.write("chaos: CHAOS_SERVER names the server command to run\n");
  process.exit(2);
}
const truthPath = process.env.FAULT_TRUTH;
const callsPath = process.env.FAULT_CALLS;

const [file, ...args] = command.split(" ").filter(Boolean);
// The logs are this shim's; the server behind it must not see them, or a fault server used as a
// stand-in would write the same effect twice.
const { FAULT_TRUTH: _t, FAULT_CALLS: _c, ...childEnv } = process.env;
const child = spawn(file, args, { env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
const toClient = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const toServer = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

const readOnly = new Set(); // tools the server marks read-only, from tools/list
const idempotent = new Set(); // tools the server marks idempotent, from tools/list
const attempts = new Map(); // step -> attempts seen
const pendingList = new Set(); // ids of tools/list requests, to learn annotations from the answer
const forwarded = new Map(); // upstream id -> what was sent, to judge the answer when it comes
const fail = (id, text) =>
  toClient({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });
// The shim lists the tools itself once the server is up, so what counts as a write does not depend
// on whether the client ever asked. The answer to its own request is not forwarded.
const OWN_LIST = "chaos:tools/list";
let initializeId;

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize" && msg.id !== undefined) initializeId = String(msg.id);
  if (msg.method === "tools/list" && msg.id !== undefined) pendingList.add(String(msg.id));
  if (msg.method !== "tools/call") return toServer(msg);

  const name = msg.params?.name;
  const args = { ...(msg.params?.arguments ?? {}) };
  const fault = args.__fault ?? "none";
  const step = args.__step ?? `${name}:${JSON.stringify(args)}`;
  delete args.__fault;
  delete args.__step;
  const n = (attempts.get(step) ?? 0) + 1;
  attempts.set(step, n);

  if (fault === "other") return fail(msg.id, "Error: internal error (see server logs)");
  if (fault === "blocked") return fail(msg.id, "permission denied for this operation");
  if (fault === "retryable" && n === 1) return fail(msg.id, "Request timed out after 30000ms");

  if (callsPath) appendFileSync(callsPath, `${name}\n`);
  if (msg.id !== undefined)
    forwarded.set(String(msg.id), {
      name,
      id: args.id ?? step,
      attempt: n,
      drop: fault === "lost" && n === 1,
    });
  toServer({ ...msg, params: { ...msg.params, arguments: args } });
});

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return process.stdout.write(`${line}\n`);
  }
  if (msg.id !== undefined && pendingList.delete(String(msg.id))) {
    for (const t of msg.result?.tools ?? []) {
      if (t?.annotations?.readOnlyHint === true) readOnly.add(t.name);
      if (t?.annotations?.idempotentHint === true) idempotent.add(t.name);
    }
    if (String(msg.id) === OWN_LIST) return;
  }
  if (msg.id !== undefined && String(msg.id) === initializeId) {
    pendingList.add(OWN_LIST);
    toServer({ jsonrpc: "2.0", id: OWN_LIST, method: "tools/list", params: {} });
  }
  const sent = msg.id !== undefined ? forwarded.get(String(msg.id)) : undefined;
  if (sent) {
    forwarded.delete(String(msg.id));
    const failed = Boolean(msg.error) || msg.result?.isError === true;
    if (truthPath && !failed && !readOnly.has(sent.name))
      appendFileSync(
        truthPath,
        `${JSON.stringify({
          effect: sent.name,
          id: sent.id,
          attempt: sent.attempt,
          by: "transport",
          idempotent: idempotent.has(sent.name),
        })}\n`,
      );
    // The world changed; the answer did not arrive.
    if (sent.drop && !failed) return fail(msg.id, "Request timed out after 30000ms");
  }
  process.stdout.write(`${line}\n`);
});

child.on("exit", (code) => process.exit(code ?? 0));
process.stdin.on("end", () => child.stdin.end());
