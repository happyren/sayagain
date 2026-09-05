/**
 * `sayagain serve`: one process on loopback, one virtual server per
 * registered upstream at /mcp/<name> (Streamable HTTP), plus the control
 * API the CLI and the future UI use. A bearer token guards everything.
 *
 * Hosts get an Mcp-Session-Id on initialize. Requests that carry it share one
 * session: responses go back on their own POST, and a GET stream with the
 * same id carries what the server initiates. A POST without a session id is
 * its own short-lived session.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { summarizeDeadLetter, summarizeHold } from "./control.js";
import { Boundary } from "./core.js";
import { type Decision, type Hold, HoldQueue } from "./holds.js";
import { isRequest, isResponse, type JsonRpcMessage, keyOfId, parseMessage } from "./jsonrpc.js";
import {
  loadRegistry,
  type Registry,
  registryPath,
  removeDaemonInfo,
  type ServerConfig,
  upstreamFor,
  writeDaemonInfo,
} from "./registry.js";
import type { Stores } from "./stores.js";
import type { Session } from "./transport.js";

export interface DaemonOptions {
  registry: Registry;
  stores: Stores;
  version: string;
  /** host:port; port 0 picks a free one. Default 127.0.0.1:7777. */
  listen?: string;
  token?: string;
  log?: (line: string) => void;
  /** Write ~/.sayagain/daemon.json so the shim and CLI can find this daemon. Default true. */
  writeInfo?: boolean;
  /** How long a POST may wait for its response (holds can take minutes). */
  responseTimeoutMs?: number;
  /** Idle host sessions (no stream, nothing in flight) are dropped after this. */
  sessionIdleMs?: number;
  /** Called after /api/shutdown has closed the daemon; the CLI exits the process here. */
  onShutdown?: () => void;
}

export interface Daemon {
  host: string;
  port: number;
  token: string;
  url: string;
  holds: HoldQueue;
  boundaries: Map<string, Boundary>;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** "host:port" without the port, when the tail is a port number. */
function stripPort(hostHeader: string): string {
  const i = hostHeader.lastIndexOf(":");
  if (i <= 0) return hostHeader;
  const tail = hostHeader.slice(i + 1);
  return tail.length > 0 && tail.length <= 5 && [...tail].every((c) => c >= "0" && c <= "9")
    ? hostHeader.slice(0, i)
    : hostHeader;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

export function parseListen(listen: string): { host: string; port: number } {
  const at = listen.lastIndexOf(":");
  const hostRaw = at >= 0 ? listen.slice(0, at) : "";
  const portRaw = at >= 0 ? listen.slice(at + 1) : listen;
  const host = hostRaw || "127.0.0.1";
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port > 65535)
    throw new Error(`--listen expects host:port, got ${JSON.stringify(listen)}`);
  return { host: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host, port };
}

/** One host that presented an Mcp-Session-Id: its POSTs settle here; its GET stream carries the rest. */
class HostSession implements Session {
  readonly waiters = new Map<string, { settle: (msg: JsonRpcMessage) => void }>();
  stream: ServerResponse | undefined;
  lastSeen = Date.now();
  constructor(readonly id: string) {}
  get bidirectional(): boolean {
    return this.stream !== undefined;
  }
  get idle(): boolean {
    return this.stream === undefined && this.waiters.size === 0;
  }
  send(msg: JsonRpcMessage): void {
    if (isResponse(msg) && msg.id !== null && msg.id !== undefined) {
      const waiter = this.waiters.get(keyOfId(msg.id));
      if (waiter) {
        this.waiters.delete(keyOfId(msg.id));
        waiter.settle(msg);
        return;
      }
    }
    if (this.stream && !this.stream.writableEnded)
      this.stream.write(`data: ${JSON.stringify(msg)}\n\n`);
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { host, port } = parseListen(
    options.listen ?? options.registry.daemon?.listen ?? "127.0.0.1:7777",
  );
  if (!LOOPBACK_HOSTS.has(host))
    log(
      `sayagain: listening on ${host}, which is not loopback; every process that can reach it and has the token can use your upstreams`,
    );
  const token = options.token ?? randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const holds = new HoldQueue();
  const boundaries = new Map<string, Boundary>();
  const hostSessions = new Map<string, HostSession>();
  const sseClients = new Set<ServerResponse>();
  const orphaned = new Map<string, Hold>();
  let sessionSeq = 0;
  let closing = false;
  let closed: Promise<void> | undefined;

  const emitEvent = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) if (!res.writableEnded) res.write(payload);
  };
  const persistHold = (h: Hold) => {
    try {
      options.stores.holds.save(h);
    } catch (err) {
      log(
        `sayagain: could not persist hold ${h.receipt}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  holds.on("decided", (h: Hold) => {
    // A deliberate shutdown rejects held calls so their hosts get an answer, but the hold itself stays
    // pending in storage: after a restart it comes back orphaned and the operator still decides.
    if (h.decision && !closing) {
      try {
        options.stores.holds.decide(h.receipt, h.decision as Decision, h.decidedAt);
      } catch (err) {
        log(
          `sayagain: could not persist hold decision: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    emitEvent("hold-decided", { receipt: h.receipt, decision: h.decision });
    const orphan = orphaned.get(h.receipt);
    if (orphan && !closing) {
      orphaned.delete(h.receipt);
      holds.forget(h.receipt);
      if (h.decision === "approve") {
        const b = boundaryFor(orphan.server ?? "");
        if (!b)
          log(
            `sayagain: hold ${h.receipt} was approved but its server ${orphan.server ?? "?"} is not registered any more`,
          );
        else
          void b.resume(orphan).then((outcome) => {
            log(
              `sayagain: resumed hold ${h.receipt} on ${orphan.server}: ${outcome.isError ? "failed" : "executed"}`,
            );
            emitEvent("hold-resumed", { ...outcome, receipt: h.receipt });
          });
      }
    }
  });

  const currentConfig = (name: string): ServerConfig | undefined => {
    const cfg = options.registry.servers[name];
    if (cfg) return cfg;
    // Registered after this daemon started? Take it from the file.
    try {
      const fresh = loadRegistry().servers[name];
      if (fresh) options.registry.servers[name] = fresh;
      return fresh;
    } catch {
      return undefined;
    }
  };

  const boundaryFor = (name: string): Boundary | undefined => {
    const existing = boundaries.get(name);
    if (existing) return existing;
    const config = currentConfig(name);
    if (!config) return undefined;
    const coreOptions: ConstructorParameters<typeof Boundary>[0] = {
      name,
      upstream: () => upstreamFor(name, config, log),
      ledger: options.stores.ledger,
      ledgerKind: options.stores.kind,
      deadLetters: options.stores.deadLetters,
      holds,
      version: options.version,
      announce: config.announce ?? true,
      log,
      restartUpstream: true,
      policy: {
        ...(config.classes ? { classes: config.classes } : {}),
        ...(config.hold ? { hold: config.hold } : {}),
      },
    };
    const b = new Boundary(coreOptions);
    b.on("row", (row) => emitEvent("row", row));
    b.on("hold", (hold: Hold) => {
      persistHold(hold);
      emitEvent("hold", summarizeHold(hold, process.pid));
    });
    b.on("dead-letter", (entry) => emitEvent("dead-letter", entry));
    boundaries.set(name, b);
    return b;
  };

  const tokenMatches = (candidate: string | null | undefined): boolean => {
    if (!candidate) return false;
    const buf = Buffer.from(candidate);
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  };
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization ?? "";
    if (header.slice(0, 7).toLowerCase() === "bearer " && tokenMatches(header.slice(7).trim()))
      return true;
    // EventSource cannot set headers: the query form is accepted for streams only.
    const wantsStream =
      req.method === "GET" && (req.headers.accept ?? "").includes("text/event-stream");
    return wantsStream && tokenMatches(url.searchParams.get("token"));
  };
  const hostAllowed = (req: IncomingMessage): boolean => {
    if (!LOOPBACK_HOSTS.has(host)) return true;
    const h = stripPort(req.headers.host ?? "");
    return h === "" || LOOPBACK_HOSTS.has(h);
  };

  const sessionFor = (id: string | undefined, create: boolean): HostSession | undefined => {
    if (!id) return undefined;
    let s = hostSessions.get(id);
    if (!s && create) {
      s = new HostSession(id);
      hostSessions.set(id, s);
    }
    if (s) s.lastSeen = Date.now();
    return s;
  };

  const startSse = (res: ServerResponse): NodeJS.Timeout => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    res.on("error", () => undefined);
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    beat.unref();
    return beat;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const boundary = boundaryFor(name);
    if (!boundary)
      return json(res, 404, {
        error: `no server named ${name}; register it with: sayagain add ${name} -- <command>`,
      });
    const presented =
      typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    if (req.method === "GET") {
      if (!(req.headers.accept ?? "").includes("text/event-stream"))
        return json(res, 405, { error: "GET needs Accept: text/event-stream" });
      const host = sessionFor(presented, true);
      const session: Session = host ?? {
        id: `sse-${++sessionSeq}`,
        send: (msg) => !res.writableEnded && res.write(`data: ${JSON.stringify(msg)}\n\n`),
      };
      if (host) {
        if (host.stream && !host.stream.writableEnded) host.stream.end(); // one stream per session; the newest wins
        host.stream = res;
      }
      boundary.attach(session);
      const beat = startSse(res);
      req.on("close", () => {
        clearInterval(beat);
        if (host) {
          if (host.stream === res) host.stream = undefined;
        } else boundary.detach(session);
      });
      return;
    }
    if (req.method === "DELETE") {
      const host = sessionFor(presented, false);
      if (!host) return json(res, 404, { error: "no such session" });
      hostSessions.delete(host.id);
      boundary.detach(host);
      host.stream?.end();
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== "POST")
      return json(res, 405, {
        error: "use POST with a JSON-RPC message, or GET with Accept: text/event-stream",
      });
    const body = await readBody(req);
    const msg = parseMessage(body);
    if (!msg) return json(res, 400, { error: "body is not JSON-RPC" });
    if (Array.isArray(msg)) return json(res, 400, { error: "JSON-RPC batches are not supported" });

    const isInit = isRequest(msg) && msg.method === "initialize";
    let host = sessionFor(presented, false);
    if (isInit && !host) host = sessionFor(randomBytes(12).toString("base64url"), true);
    if (presented && !host)
      return json(res, 404, { error: "unknown Mcp-Session-Id; initialize again" });
    const extra: Record<string, string> = host ? { "mcp-session-id": host.id } : {};

    if (!isRequest(msg)) {
      const session: Session = host ?? {
        id: `http-${++sessionSeq}`,
        send: () => undefined,
        bidirectional: false,
      };
      boundary.attach(session);
      try {
        await boundary.handle(session, body);
      } finally {
        if (!host) boundary.detach(session);
      }
      res.writeHead(202, extra);
      return res.end();
    }

    const wanted = keyOfId(msg.id);
    let settle: (reply: JsonRpcMessage | null) => void = () => undefined;
    const reply = new Promise<JsonRpcMessage | null>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => settle(null), options.responseTimeoutMs ?? 900_000);
    timer.unref();
    let session: Session;
    if (host) {
      host.waiters.set(wanted, { settle: (m) => settle(m) });
      session = host;
    } else {
      session = {
        id: `http-${++sessionSeq}`,
        bidirectional: false,
        send: (m: JsonRpcMessage) => {
          if (isResponse(m) && m.id !== null && m.id !== undefined && keyOfId(m.id) === wanted)
            settle(m);
        },
      };
    }
    // A host that goes away mid-call: stop waiting; a held call stays for the operator (its result lands in the ledger).
    req.on("close", () => {
      if (!res.writableEnded) settle(null);
    });
    boundary.attach(session);
    try {
      await boundary.handle(session, body);
      const out = await reply;
      clearTimeout(timer);
      if (out === null) {
        if (res.writableEnded || req.destroyed) return;
        return json(
          res,
          504,
          {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Say Again: no response within the daemon's limit" },
          },
          extra,
        );
      }
      return json(res, 200, out, extra);
    } finally {
      clearTimeout(timer);
      if (host) host.waiters.delete(wanted);
      else boundary.detach(session);
    }
  };

  const clampTail = (raw: string | null, fallback: number): number => {
    const n = Number(raw ?? fallback);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/health") {
      return json(res, 200, {
        ok: true,
        version: options.version,
        pid: process.pid,
        servers: Object.keys(options.registry.servers),
        ledger: options.stores.kind,
      });
    }
    if (req.method === "GET" && path === "/api/servers") {
      let servers = options.registry.servers;
      if (existsSync(registryPath())) {
        try {
          servers = loadRegistry().servers;
          options.registry.servers = servers;
        } catch {
          // keep the snapshot
        }
      }
      return json(
        res,
        200,
        Object.entries(servers).map(([name, cfg]) => {
          const b = boundaries.get(name);
          return {
            name,
            transport: cfg.transport,
            target:
              cfg.transport === "http" ? cfg.url : [cfg.command, ...(cfg.args ?? [])].join(" "),
            started: !!b,
            upstream: b?.upstreamName ?? null,
            ready: b?.upstreamReady ?? false,
            sessions: b?.sessionCount ?? 0,
            url: `${daemonUrl}/mcp/${name}`,
          };
        }),
      );
    }
    if (req.method === "GET" && path === "/api/holds")
      return json(
        res,
        200,
        holds.list().map((h) => summarizeHold(h, process.pid)),
      );
    const decide = path.match(/^\/api\/holds\/([^/]+)\/(approve|reject)$/);
    if (req.method === "POST" && decide) {
      const receipt = decodeURIComponent(decide[1] ?? "");
      return json(res, 200, { receipt, decided: holds.decide(receipt, decide[2] as Decision) });
    }
    if (req.method === "GET" && path === "/api/deadletters")
      return json(
        res,
        200,
        options.stores.deadLetters.list().map((d) => summarizeDeadLetter(d, process.pid)),
      );
    const replay = path.match(/^\/api\/replay\/([^/]+)$/);
    if (req.method === "POST" && replay) {
      const receipt = decodeURIComponent(replay[1] ?? "");
      const body = await readBody(req);
      let args: unknown;
      if (body.trim()) {
        try {
          args = (JSON.parse(body) as { arguments?: unknown }).arguments;
        } catch {
          return json(res, 400, { error: 'body must be JSON like {"arguments": {...}}' });
        }
      }
      const entry = options.stores.deadLetters.get(receipt);
      if (!entry) return json(res, 404, { error: `no dead letter ${receipt}` });
      const b = entry.server !== undefined ? boundaryFor(entry.server) : undefined;
      if (!b)
        return json(res, 409, {
          error: `dead letter ${receipt} belongs to server ${entry.server ?? "(unknown)"}, which is not registered`,
        });
      return json(res, 200, (await b.replay(receipt, args)) ?? { error: "not found" });
    }
    if (req.method === "GET" && path === "/api/ledger")
      return json(
        res,
        200,
        options.stores.readLedger(clampTail(url.searchParams.get("tail"), 100)),
      );
    if (req.method === "GET" && path === "/api/events") {
      const beat = startSse(res);
      sseClients.add(res);
      req.on("close", () => {
        clearInterval(beat);
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === "POST" && path === "/api/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => void daemon.close().then(() => options.onShutdown?.()), 50).unref();
      return;
    }
    return json(res, 404, { error: "unknown API route" });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    void (async () => {
      try {
        if (!hostAllowed(req)) return json(res, 421, { error: "Host header is not loopback" });
        if (!authorized(req, url))
          return json(res, 401, { error: "missing or wrong bearer token" });
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > MAX_BODY)
          return json(res, 413, { error: "body too large" }, { connection: "close" });
        const mcp = url.pathname.match(/^\/mcp\/([A-Za-z0-9_.-]+)\/?$/);
        if (mcp) return await handleMcp(req, res, mcp[1] ?? "");
        if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
        return json(res, 404, { error: "not found" });
      } catch (err) {
        log(`sayagain: request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(res, 500, { error: "request failed; see the daemon log" });
        else res.end();
      }
    })();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const infoHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const daemonUrl = `http://${infoHost}:${boundPort}`;

  const idleSweep = setInterval(() => {
    const cutoff = Date.now() - (options.sessionIdleMs ?? 1_800_000);
    for (const [id, s] of hostSessions)
      if (s.idle && s.lastSeen < cutoff) {
        hostSessions.delete(id);
        for (const b of boundaries.values()) b.detach(s);
      }
  }, 60_000);
  idleSweep.unref();

  for (const h of options.stores.holds.pending()) {
    const hold: Hold = { ...h, orphaned: true };
    orphaned.set(hold.receipt, hold);
    holds.create(hold);
  }
  if (orphaned.size)
    log(
      `sayagain: ${orphaned.size} hold(s) from before the restart are waiting for a decision (sayagain holds)`,
    );

  if (options.writeInfo ?? true)
    writeDaemonInfo({
      pid: process.pid,
      host: infoHost,
      port: boundPort,
      token,
      startedAt: new Date().toISOString(),
      version: options.version,
    });

  const daemon: Daemon = {
    host: infoHost,
    port: boundPort,
    token,
    url: daemonUrl,
    holds,
    boundaries,
    close: () => {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        clearInterval(idleSweep);
        await Promise.all([...boundaries.values()].map((b) => b.close()));
        const streams = [...sseClients, ...[...hostSessions.values()].map((s) => s.stream)];
        sseClients.clear();
        for (const res of streams) res?.end();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
        if (options.writeInfo ?? true) removeDaemonInfo();
        options.stores.close();
      })();
      return closed;
    },
  };
  return daemon;
}
