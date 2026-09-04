#!/usr/bin/env node
/**
 * Transparent stdio tap for an MCP server. Forwards bytes unchanged in both
 * directions and logs one JSON line per JSON-RPC message with method, tool
 * name, argument key names, error flag, byte size and latency. Argument
 * values, results and content are never logged.
 *
 * Usage:
 *   node scripts/baseline/mcp-tap.mjs --log tap.jsonl -- <server command> [args...]
 *
 * Point your agent's MCP configuration at this command instead of the
 * server, keep the log for two weeks, then analyse it (docs/measurement.md).
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  process.stderr.write("usage: mcp-tap.mjs [--log file] -- <server command> [args...]\n");
  process.exit(2);
}
const logIdx = argv.indexOf("--log");
const LOG = logIdx >= 0 && logIdx < sep ? argv[logIdx + 1] : "mcp-tap.jsonl";
const [cmd, ...cmdArgs] = argv.slice(sep + 1);

const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map(); // id -> { name, method, startedAt }

const log = (rec) => {
  try {
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
  } catch {
    // never let logging break the transport
  }
};

const argKeys = (params) => {
  const a = params?.arguments;
  return a && typeof a === "object" && !Array.isArray(a) ? Object.keys(a).sort() : [];
};

function observe(dir, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const bytes = Buffer.byteLength(line);
  const messages = Array.isArray(msg) ? msg : [msg];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (dir === "client" && typeof m.method === "string") {
      const rec = {
        dir,
        kind: m.id === undefined ? "notification" : "request",
        id: m.id ?? null,
        method: m.method,
        bytes,
      };
      if (m.method === "tools/call" && m.params) {
        rec.name = m.params.name;
        rec.argKeys = argKeys(m.params);
        rec.hasMeta = m.params._meta !== undefined;
      }
      if (m.id !== undefined)
        pending.set(String(m.id), { method: m.method, name: rec.name, startedAt: Date.now() });
      log(rec);
    } else if (
      dir === "server" &&
      m.id !== undefined &&
      (m.result !== undefined || m.error !== undefined)
    ) {
      const p = pending.get(String(m.id));
      pending.delete(String(m.id));
      const rec = {
        dir,
        kind: "response",
        id: m.id,
        method: p?.method ?? null,
        name: p?.name ?? null,
        bytes,
        latencyMs: p ? Date.now() - p.startedAt : null,
      };
      if (m.error) {
        rec.isError = true;
        rec.errorCode = m.error.code ?? null;
      } else {
        rec.isError = m.result && typeof m.result === "object" && m.result.isError === true;
      }
      log(rec);
    } else if (dir === "server" && typeof m.method === "string") {
      log({
        dir,
        kind: m.id === undefined ? "notification" : "request",
        id: m.id ?? null,
        method: m.method,
        bytes,
      });
    }
  }
}

function pipeWithTap(src, dst, dir) {
  let buf = "";
  src.on("data", (chunk) => {
    dst.write(chunk);
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) observe(dir, line);
      nl = buf.indexOf("\n");
    }
  });
  src.on("end", () => dst.end());
}

pipeWithTap(process.stdin, child.stdin, "client");
pipeWithTap(child.stdout, process.stdout, "server");
child.on("exit", (code, signal) => {
  log({ dir: "tap", kind: "exit", code, signal, unanswered: pending.size });
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
