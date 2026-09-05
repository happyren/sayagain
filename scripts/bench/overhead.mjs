#!/usr/bin/env node
/**
 * M15e: boundary overhead on pass-through calls, local transport.
 * Runs N sequential `echo` calls three ways against test/fake-server.mjs:
 * direct stdio, through `wrap` (stdio), and through the daemon (HTTP).
 * Prints p50/p95/p99 of wall time per call; overhead is the difference.
 *
 *   node scripts/bench/overhead.mjs [--calls 500]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fake = join(root, "packages/proxy/test/fake-server.mjs");
const cli = join(root, "packages/proxy/dist/cli.js");
const callsAt = process.argv.indexOf("--calls");
const calls = callsAt >= 0 ? Number(process.argv[callsAt + 1]) : 500;
if (!Number.isFinite(calls) || calls < 1) throw new Error("--calls needs a positive number");
const home = mkdtempSync(join(tmpdir(), "sayagain-bench-"));
process.env.SAYAGAIN_HOME = home;

const pct = (xs, p) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const report = (name, xs) =>
  console.log(
    `${name.padEnd(14)} p50 ${pct(xs, 50).toFixed(2)} ms  p95 ${pct(xs, 95).toFixed(2)} ms  p99 ${pct(xs, 99).toFixed(2)} ms  (n=${xs.length})`,
  );

function stdioClient(cmd, args) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const waiters = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        const w = m.id !== undefined ? waiters.get(m.id) : undefined;
        if (w) {
          waiters.delete(m.id);
          w(m);
        }
      } catch {
        // not JSON: a stray stderr-ish line on stdout
      }
    }
  });
  let seq = 0;
  return {
    call: (method, params) =>
      new Promise((resolve) => {
        const id = ++seq;
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    close: () => child.kill(),
  };
}

async function measureStdio(name, cmd, args) {
  const c = stdioClient(cmd, args);
  await c.call("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "bench", version: "0" },
  });
  c.notify("notifications/initialized");
  await new Promise((r) => setTimeout(r, 300));
  const xs = [];
  for (let i = 0; i < calls; i++) {
    const t = performance.now();
    await c.call("tools/call", { name: "echo", arguments: { i } });
    xs.push(performance.now() - t);
  }
  c.close();
  report(name, xs);
  return xs;
}

async function measureDaemon() {
  const { startDaemon, openStores } = await import(join(root, "packages/proxy/dist/index.js"));
  const d = await startDaemon({
    registry: {
      servers: { fake: { transport: "stdio", command: process.execPath, args: [fake] } },
    },
    stores: openStores("memory"),
    version: "bench",
    listen: "127.0.0.1:0",
    writeInfo: false,
    log: () => {},
  });
  const headers = { authorization: `Bearer ${d.token}`, "content-type": "application/json" };
  const post = (msg) =>
    fetch(`${d.url}/mcp/fake`, { method: "POST", headers, body: JSON.stringify(msg) }).then((r) =>
      r.status === 202 ? null : r.json(),
    );
  await post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "bench", version: "0" },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 300));
  const xs = [];
  for (let i = 1; i <= calls; i++) {
    const t = performance.now();
    await post({
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "echo", arguments: { i } },
    });
    xs.push(performance.now() - t);
  }
  await d.close();
  report("daemon (http)", xs);
  return xs;
}

const direct = await measureStdio("direct stdio", process.execPath, [fake]);
const wrapped = await measureStdio("wrap (stdio)", process.execPath, [
  cli,
  "wrap",
  "--ledger",
  join(home, "l.jsonl"),
  "--",
  process.execPath,
  fake,
]);
const daemon = await measureDaemon();
console.log(
  `overhead p99: wrap +${(pct(wrapped, 99) - pct(direct, 99)).toFixed(2)} ms, daemon +${(pct(daemon, 99) - pct(direct, 99)).toFixed(2)} ms (gate: < 25 ms)`,
);
rmSync(home, { recursive: true, force: true });
