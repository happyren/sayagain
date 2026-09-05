/**
 * Control channel between a running boundary and the CLI: one JSON line in,
 * one JSON line out, over a Unix socket (a named pipe on Windows). The
 * daemon replaces this with its HTTP API in 0.4.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Decision, Hold, HoldQueue } from "./holds.js";

export const runDir = (): string => join(homedir(), ".sayagain", "run");

export function socketPathFor(pid: number): string {
  return platform() === "win32" ? `\\\\.\\pipe\\sayagain-${pid}` : join(runDir(), `${pid}.sock`);
}

export type ControlRequest = { op: "list" } | { op: "decide"; receipt: string; decision: Decision };
export type ControlResponse =
  | { ok: true; holds: HoldSummary[] }
  | { ok: true; decided: boolean; receipt: string }
  | { ok: false; error: string };

export interface HoldSummary {
  receipt: string;
  tool: string;
  toolClass: string;
  reason: string;
  intent?: string;
  arguments: unknown;
  createdAt: string;
  expiresAt: string;
  pid: number;
}

const summarize = (h: Hold, pid: number): HoldSummary => {
  const s: HoldSummary = {
    receipt: h.receipt,
    tool: h.tool,
    toolClass: h.toolClass,
    reason: h.reason,
    arguments: h.arguments,
    createdAt: new Date(h.createdAt).toISOString(),
    expiresAt: new Date(h.expiresAt).toISOString(),
    pid,
  };
  if (h.intent !== undefined) s.intent = h.intent;
  return s;
};

export function startControlServer(queue: HoldQueue, path = socketPathFor(process.pid)): Server {
  if (platform() !== "win32") {
    mkdirSync(runDir(), { recursive: true });
    if (existsSync(path)) rmSync(path);
  }
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let response: ControlResponse;
      try {
        const req = JSON.parse(line) as ControlRequest;
        if (req.op === "list")
          response = { ok: true, holds: queue.list().map((h) => summarize(h, process.pid)) };
        else if (req.op === "decide")
          response = {
            ok: true,
            decided: queue.decide(req.receipt, req.decision),
            receipt: req.receipt,
          };
        else response = { ok: false, error: "unknown op" };
      } catch (err) {
        response = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  server.listen(path);
  const cleanup = () => {
    server.close();
    if (platform() !== "win32" && existsSync(path)) rmSync(path, { force: true });
  };
  process.on("exit", cleanup);
  return server;
}

export function ask(
  path: string,
  request: ControlRequest,
  timeoutMs = 2000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout talking to ${path}`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (c) => {
      buf += c.toString();
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()) as ControlResponse);
      } catch {
        reject(new Error(`bad reply from ${path}`));
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Every live boundary on this machine, by socket path. Stale sockets are removed. */
export function liveSockets(): string[] {
  if (platform() === "win32") return [];
  if (!existsSync(runDir())) return [];
  const out: string[] = [];
  for (const f of readdirSync(runDir())) {
    if (!f.endsWith(".sock")) continue;
    const pid = Number(f.slice(0, -5));
    try {
      process.kill(pid, 0);
      out.push(join(runDir(), f));
    } catch {
      rmSync(join(runDir(), f), { force: true });
    }
  }
  return out;
}

export async function listAllHolds(): Promise<HoldSummary[]> {
  const holds: HoldSummary[] = [];
  for (const p of liveSockets()) {
    try {
      const r = await ask(p, { op: "list" });
      if (r.ok && "holds" in r) holds.push(...r.holds);
    } catch {
      // a boundary that does not answer has no holds to show
    }
  }
  return holds.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function decideEverywhere(receipt: string, decision: Decision): Promise<boolean> {
  for (const p of liveSockets()) {
    try {
      const r = await ask(p, { op: "decide", receipt, decision });
      if (r.ok && "decided" in r && r.decided) return true;
    } catch {
      // try the next boundary
    }
  }
  return false;
}
