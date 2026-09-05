/**
 * Control channel between a running boundary and the CLI: one JSON line in,
 * one JSON line out, over a Unix socket (a named pipe on Windows, with a
 * marker file so the CLI can find it). The daemon replaces this in 0.4.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import type { DeadLetter } from "./deadletter.js";
import type { Decision, Hold, HoldQueue } from "./holds.js";
import { homePath } from "./home.js";
import { LineSplitter } from "./jsonrpc.js";

export const runDir = (): string => homePath("run");
const isWindows = () => platform() === "win32";

export function socketPathFor(pid: number): string {
  return isWindows() ? `\\\\.\\pipe\\sayagain-${pid}` : join(runDir(), `${pid}.sock`);
}

export type ControlRequest =
  | { op: "list" }
  | { op: "decide"; receipt: string; decision: Decision }
  | { op: "deadletters" }
  | { op: "replay"; receipt: string; arguments?: unknown };
export type ControlResponse =
  | { ok: true; holds: HoldSummary[] }
  | { ok: true; decided: boolean; receipt: string }
  | { ok: true; deadletters: DeadLetterSummary[] }
  | { ok: true; replayed: ReplayOutcome }
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
  upstream?: string;
  server?: string;
  mode?: string;
  /** Reloaded after a daemon restart: no host is waiting; approving executes it for the ledger. */
  orphaned?: boolean;
}

export interface DeadLetterSummary {
  receipt: string;
  ts: string;
  upstream: string;
  tool: string;
  intent?: string;
  errorClass: string;
  errorSignature: string;
  attempts: number;
  repairs: number;
  pid: number;
  server?: string;
}

export interface ReplayOutcome {
  receipt: string;
  replayOf: string;
  isError: boolean;
  text: string;
}

export interface ControlHandlers {
  deadletters?: () => DeadLetterSummary[];
  replay?: (receipt: string, args: unknown) => Promise<ReplayOutcome | null>;
}

export const summarizeHold = (h: Hold, pid: number): HoldSummary => {
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
  if (h.upstream !== undefined) s.upstream = h.upstream;
  if (h.server !== undefined) s.server = h.server;
  if (h.mode !== undefined) s.mode = h.mode;
  if (h.orphaned) s.orphaned = true;
  return s;
};

export const summarizeDeadLetter = (d: DeadLetter, pid: number): DeadLetterSummary => {
  const s: DeadLetterSummary = {
    receipt: d.receipt,
    ts: d.ts,
    upstream: d.upstream,
    tool: d.tool,
    errorClass: d.errorClass,
    errorSignature: d.errorSignature,
    attempts: d.attempts,
    repairs: d.repairs,
    pid,
  };
  if (d.intent !== undefined) s.intent = d.intent;
  if (d.server !== undefined) s.server = d.server;
  return s;
};

const MAX_REQUEST_BYTES = 1_000_000;

export function startControlServer(
  queue: HoldQueue,
  path = socketPathFor(process.pid),
  handlers: ControlHandlers = {},
): Server {
  mkdirSync(runDir(), { recursive: true });
  const marker = isWindows() ? join(runDir(), `${process.pid}.pipe`) : path;
  if (!isWindows() && existsSync(path)) rmSync(path);
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    const lines = new LineSplitter();
    let seen = 0;
    let handled = false;
    socket.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const [line] = lines.push(chunk);
      if (line === undefined || handled) return;
      handled = true;
      const handle = async (): Promise<ControlResponse> => {
        const req = JSON.parse(line) as ControlRequest;
        if (req.op === "list")
          return { ok: true, holds: queue.list().map((h) => summarizeHold(h, process.pid)) };
        if (req.op === "decide")
          return {
            ok: true,
            decided: queue.decide(req.receipt, req.decision),
            receipt: req.receipt,
          };
        if (req.op === "deadletters")
          return { ok: true, deadletters: handlers.deadletters ? handlers.deadletters() : [] };
        if (req.op === "replay") {
          if (!handlers.replay)
            return { ok: false, error: "replay not supported by this boundary" };
          const outcome = await handlers.replay(req.receipt, req.arguments);
          return outcome
            ? { ok: true, replayed: outcome }
            : { ok: false, error: `no dead letter ${req.receipt} here` };
        }
        return { ok: false, error: "unknown op" };
      };
      handle()
        .catch(
          (err: unknown): ControlResponse => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        .then((response) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        });
    });
  });
  server.on("error", (err) =>
    process.stderr.write(`sayagain: control socket error: ${err.message}\n`),
  );
  server.listen(path, () => {
    if (isWindows()) writeFileSync(marker, path);
  });
  const cleanup = () => {
    server.close();
    if (existsSync(marker)) rmSync(marker, { force: true });
  };
  process.on("exit", cleanup);
  server.on("close", () => {
    process.off("exit", cleanup);
    if (existsSync(marker)) rmSync(marker, { force: true });
  });
  return server;
}

export function ask(
  path: string,
  request: ControlRequest,
  timeoutMs = 2000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const lines = new LineSplitter();
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout talking to ${path}`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (c) => {
      for (const l of lines.push(c)) buf ||= l;
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const last = buf || lines.flush() || "";
      try {
        resolve(JSON.parse(last) as ControlResponse);
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Every live boundary on this machine, by socket (or pipe) path. Stale entries are removed. */
export function liveSockets(): string[] {
  if (!existsSync(runDir())) return [];
  const out: string[] = [];
  for (const f of readdirSync(runDir())) {
    const suffix = isWindows() ? ".pipe" : ".sock";
    if (!f.endsWith(suffix)) continue;
    const pid = Number(f.slice(0, -suffix.length));
    if (Number.isFinite(pid) && alive(pid))
      out.push(isWindows() ? socketPathFor(pid) : join(runDir(), f));
    else rmSync(join(runDir(), f), { force: true });
  }
  return out;
}

async function askAll(request: ControlRequest, timeoutMs = 2000): Promise<ControlResponse[]> {
  const results = await Promise.allSettled(liveSockets().map((p) => ask(p, request, timeoutMs)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

export async function listAllHolds(): Promise<HoldSummary[]> {
  const holds: HoldSummary[] = [];
  for (const r of await askAll({ op: "list" })) if (r.ok && "holds" in r) holds.push(...r.holds);
  return holds.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllDeadLetters(): Promise<DeadLetterSummary[]> {
  const out: DeadLetterSummary[] = [];
  for (const r of await askAll({ op: "deadletters" }))
    if (r.ok && "deadletters" in r) out.push(...r.deadletters);
  return out;
}

export async function replayEverywhere(
  receipt: string,
  args: unknown,
): Promise<ReplayOutcome | null> {
  for (const r of await askAll({ op: "replay", receipt, arguments: args }, 45_000))
    if (r.ok && "replayed" in r) return r.replayed;
  return null;
}

export async function decideEverywhere(receipt: string, decision: Decision): Promise<boolean> {
  for (const r of await askAll({ op: "decide", receipt, decision }))
    if (r.ok && "decided" in r && r.decided) return true;
  return false;
}
