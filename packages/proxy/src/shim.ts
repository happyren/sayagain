/**
 * `sayagain stdio <name>`: a thin stdio client for hosts that only spawn
 * commands. Each line becomes a POST to the daemon's /mcp/<name>; server
 * notifications arrive on a GET stream. Starts the daemon when none is
 * running. Fails closed: if the daemon cannot be reached, requests get a
 * JSON-RPC error instead of a silent bypass.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRequest, LineSplitter, parseMessage } from "./jsonrpc.js";
import { type DaemonInfo, readDaemonInfo } from "./registry.js";

export interface ShimOptions {
  name: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (line: string) => void;
  /** Spawn `sayagain serve --detach` when no daemon answers. Default true. */
  autoStart?: boolean;
  startTimeoutMs?: number;
  fetch?: typeof fetch;
}

export async function daemonHealthy(
  info: DaemonInfo,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch(`http://${info.host}:${info.port}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon(opts: {
  autoStart: boolean;
  startTimeoutMs: number;
  log: (l: string) => void;
  fetch: typeof fetch;
}): Promise<DaemonInfo | null> {
  const existing = readDaemonInfo();
  if (existing && (await daemonHealthy(existing, opts.fetch))) return existing;
  if (!opts.autoStart) return null;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(cli)) return null;
  opts.log("sayagain: no daemon running; starting one");
  const child = spawn(process.execPath, [cli, "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + opts.startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonInfo();
    if (info && info.pid === child.pid && (await daemonHealthy(info, opts.fetch))) return info;
  }
  return null;
}

export async function runStdioShim(options: ShimOptions): Promise<number> {
  const log = options.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const doFetch = options.fetch ?? fetch;
  const info = await ensureDaemon({
    autoStart: options.autoStart ?? true,
    startTimeoutMs: options.startTimeoutMs ?? 10_000,
    log,
    fetch: doFetch,
  });
  const write = (msg: unknown) => options.output.write(`${JSON.stringify(msg)}\n`);
  if (!info) {
    log("sayagain: no daemon is reachable and none could be started; failing closed");
    // Answer every request with an error so the host does not hang, then exit when stdin closes.
    const lines = new LineSplitter();
    options.input.on("data", (c: Buffer | string) => {
      for (const line of lines.push(c)) {
        const msg = parseMessage(line);
        if (msg && !Array.isArray(msg) && isRequest(msg))
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32000,
              message: "Say Again: the daemon is not reachable; run `sayagain serve`",
            },
          });
      }
    });
    await new Promise((r) => options.input.on("end", r));
    return 1;
  }
  const base = `http://${info.host}:${info.port}/mcp/${options.name}`;
  const headers = {
    authorization: `Bearer ${info.token}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  // Server-initiated messages (notifications, requests) arrive on the event stream.
  const streamController = new AbortController();
  void (async () => {
    try {
      const res = await doFetch(base, {
        headers: { authorization: headers.authorization, accept: "text/event-stream" },
        signal: streamController.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf("\n\n");
        while (sep >= 0) {
          const data = buf
            .slice(0, sep)
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          buf = buf.slice(sep + 2);
          if (data) options.output.write(`${data}\n`);
          sep = buf.indexOf("\n\n");
        }
      }
    } catch {
      // stream closed; requests still work over POST
    }
  })();

  const post = async (line: string) => {
    const msg = parseMessage(line);
    try {
      const res = await doFetch(base, { method: "POST", headers, body: line });
      if (res.status === 202 || res.status === 204) return;
      const text = await res.text();
      if (text.trim()) options.output.write(`${text.trim()}\n`);
    } catch (err) {
      if (msg && !Array.isArray(msg) && isRequest(msg))
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: `Say Again: daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
    }
  };

  const lines = new LineSplitter();
  const inflight = new Set<Promise<void>>();
  options.input.on("data", (c: Buffer | string) => {
    for (const line of lines.push(c)) {
      const p = post(line).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  await new Promise((r) => options.input.on("end", r));
  const rest = lines.flush();
  if (rest) await post(rest);
  await Promise.allSettled([...inflight]);
  streamController.abort();
  return 0;
}
