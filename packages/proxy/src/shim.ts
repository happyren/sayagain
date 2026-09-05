/**
 * `sayagain stdio <name>`: a thin stdio client for hosts that only spawn
 * commands. Each line becomes a POST to the daemon's /mcp/<name>; server
 * notifications and requests arrive on a GET stream. Starts the daemon when
 * none is running, follows a daemon restart (re-initialises transparently),
 * and fails closed: when the daemon cannot be reached, requests get a
 * JSON-RPC error instead of a silent bypass.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  LineSplitter,
  parseMessage,
} from "./jsonrpc.js";
import { type DaemonInfo, readDaemonInfo } from "./registry.js";

export interface ShimOptions {
  name: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (line: string) => void;
  /** Spawn `sayagain serve` when no daemon answers. Default true. */
  autoStart?: boolean;
  startTimeoutMs?: number;
}

export async function daemonHealthy(info: DaemonInfo, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll for a healthy daemon (any daemon; `pid` narrows it to one just spawned) until the deadline. */
export async function waitForDaemon(timeoutMs: number, pid?: number): Promise<DaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readDaemonInfo();
    if (info && (pid === undefined || info.pid === pid) && (await daemonHealthy(info))) return info;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Command line that starts a detached daemon; `--disable-warning` keeps node:sqlite's notice out of host logs. */
export const serveArgv = (extra: string[] = []): { file: string; args: string[] } => ({
  file: process.execPath,
  args: [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./cli.js", import.meta.url)),
    "serve",
    ...extra,
  ],
});

export async function ensureDaemon(opts: {
  autoStart: boolean;
  startTimeoutMs: number;
  log: (l: string) => void;
}): Promise<DaemonInfo | null> {
  const existing = readDaemonInfo();
  if (existing && (await daemonHealthy(existing))) return existing;
  if (!opts.autoStart) return null;
  const { file, args } = serveArgv();
  if (!existsSync(args[1] ?? "")) return null;
  opts.log("sayagain: no daemon running; starting one");
  // A GUI host launches without a shell PATH; make sure the daemon can at least find this Node.js and npx.
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
  const child = spawn(file, args, { detached: true, stdio: "ignore", env });
  child.on("error", (err) => opts.log(`sayagain: could not start the daemon: ${err.message}`));
  child.unref();
  // Accept whichever daemon is healthy: when several shims start at once, one of them wins the
  // start and the others must use it rather than wait for a child that exited.
  return waitForDaemon(opts.startTimeoutMs);
}

interface HttpReply {
  status: number;
  sessionId?: string;
  text: string;
}

const keepAlive = new Agent({ keepAlive: true });

function post(
  info: DaemonInfo,
  path: string,
  body: string,
  sessionId?: string,
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: info.host,
        port: info.port,
        path,
        method: "POST",
        agent: keepAlive,
        headers: {
          authorization: `Bearer ${info.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const sid = res.headers["mcp-session-id"];
          const reply: HttpReply = {
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          };
          if (typeof sid === "string") reply.sessionId = sid;
          resolve(reply);
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Open the GET stream; resolves when it ends (or fails). Data events carry one JSON-RPC message each. */
function stream(
  info: DaemonInfo,
  path: string,
  sessionId: string | undefined,
  onMessage: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: info.host,
        port: info.port,
        path,
        method: "GET",
        headers: {
          authorization: `Bearer ${info.token}`,
          accept: "text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          res.on("end", resolve);
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep = buf.indexOf("\n\n");
          while (sep >= 0) {
            const data = buf
              .slice(0, sep)
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            buf = buf.slice(sep + 2);
            if (data) onMessage(data);
            sep = buf.indexOf("\n\n");
          }
        });
        res.on("end", resolve);
        res.on("error", resolve);
      },
    );
    req.on("error", () => resolve());
    signal.addEventListener("abort", () => req.destroy(), { once: true });
    req.end();
  });
}

const errorFor = (id: JsonRpcId, message: string): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message },
});

export async function runStdioShim(options: ShimOptions): Promise<number> {
  const log = options.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const autoStart = options.autoStart ?? true;
  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  let alive = true;
  options.output.on("error", () => {
    alive = false;
  });
  const write = (text: string) => {
    if (alive) options.output.write(`${text}\n`);
  };
  const writeMessage = (msg: JsonRpcMessage) => write(JSON.stringify(msg));

  let info = await ensureDaemon({ autoStart, startTimeoutMs, log });
  const path = `/mcp/${encodeURIComponent(options.name)}`;
  let sessionId: string | undefined;
  let initLine: string | undefined;
  let lastReconnect = 0;
  const streamController = new AbortController();
  let streamOpen = false;

  const openStream = () => {
    if (streamOpen || !info || streamController.signal.aborted) return;
    streamOpen = true;
    const current = info;
    void (async () => {
      let backoff = 500;
      while (!streamController.signal.aborted && info === current) {
        const started = Date.now();
        await stream(current, path, sessionId, write, streamController.signal);
        if (streamController.signal.aborted || info !== current) break;
        backoff = Date.now() - started > 30_000 ? 500 : Math.min(backoff * 2, 10_000);
        await new Promise((r) => setTimeout(r, backoff));
      }
      streamOpen = false;
    })();
  };

  /** The daemon went away or rejected our token: find (or start) one and re-initialise on it. */
  const reconnect = async (): Promise<boolean> => {
    if (Date.now() - lastReconnect < 2000) return false;
    lastReconnect = Date.now();
    const found = await ensureDaemon({ autoStart, startTimeoutMs, log });
    if (!found) return false;
    info = found;
    sessionId = undefined;
    streamOpen = false;
    if (initLine) {
      try {
        const reply = await post(found, path, initLine);
        if (reply.status === 200) {
          sessionId = reply.sessionId;
          await post(
            found,
            path,
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            sessionId,
          );
        }
      } catch {
        return false;
      }
    }
    openStream();
    return true;
  };

  const send = async (line: string, msg: JsonRpcMessage, retried = false): Promise<void> => {
    if (!info) {
      if (!(await reconnect())) {
        if (isRequest(msg))
          writeMessage(
            errorFor(msg.id, "Say Again: the daemon is not reachable; run `sayagain serve`"),
          );
        return;
      }
    }
    const current = info as DaemonInfo;
    let reply: HttpReply;
    try {
      reply = await post(current, path, line, sessionId);
    } catch (err) {
      if (!retried && (await reconnect())) return send(line, msg, true);
      if (isRequest(msg))
        writeMessage(
          errorFor(
            msg.id,
            `Say Again: daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }
    if (reply.status === 401 && !retried && (await reconnect())) return send(line, msg, true);
    if (reply.status === 202 || reply.status === 204) return;
    if (isRequest(msg) && msg.method === "initialize" && reply.status === 200) {
      initLine = line;
      sessionId = reply.sessionId;
      openStream();
    }
    const parsed = parseMessage(reply.text);
    const isOurs =
      parsed &&
      !Array.isArray(parsed) &&
      isResponse(parsed) &&
      isRequest(msg) &&
      String(parsed.id) === String(msg.id);
    if (reply.status === 200 || isOurs) {
      if (reply.text.trim()) write(reply.text.trim());
      return;
    }
    if (isRequest(msg)) {
      let detail = reply.text.trim();
      try {
        detail = String((JSON.parse(detail) as { error?: unknown }).error ?? detail);
      } catch {
        // keep the raw text
      }
      writeMessage(
        errorFor(msg.id, `Say Again: daemon answered ${reply.status}: ${detail.slice(0, 200)}`),
      );
    }
  };

  const lines = new LineSplitter();
  const inflight = new Set<Promise<void>>();
  // Requests run concurrently, except that everything waits for an initialize in flight: its reply
  // carries the session id the later requests must present.
  let gate: Promise<void> = Promise.resolve();
  const feed = (line: string) => {
    const msg = parseMessage(line);
    if (!msg || Array.isArray(msg)) return;
    const isInit = isRequest(msg) && msg.method === "initialize";
    const p = (isInit ? send(line, msg) : gate.then(() => send(line, msg))).finally(() =>
      inflight.delete(p),
    );
    if (isInit) gate = p.catch(() => undefined);
    inflight.add(p);
  };
  options.input.on("data", (c: Buffer | string) => {
    for (const line of lines.push(c)) feed(line);
  });
  await new Promise((r) => options.input.on("end", r));
  const rest = lines.flush();
  if (rest) feed(rest);
  await Promise.allSettled([...inflight]);
  streamController.abort();
  keepAlive.destroy();
  return info ? 0 : 1;
}
