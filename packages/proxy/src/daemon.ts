/**
 * `sayagain serve`: one process on loopback, one virtual server per
 * registered upstream at /mcp/<name> (Streamable HTTP), plus the control
 * API the CLI and the future UI use. A bearer token guards everything.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { summarizeDeadLetter, summarizeHold } from "./control.js";
import { Boundary } from "./core.js";
import { HoldQueue } from "./holds.js";
import { isRequest, isResponse, type JsonRpcMessage, keyOfId, parseMessage } from "./jsonrpc.js";
import type { Registry, ServerConfig } from "./registry.js";
import { removeDaemonInfo, upstreamFor, writeDaemonInfo } from "./registry.js";
import type { Stores } from "./stores.js";
import type { Session } from "./transport.js";

export interface DaemonOptions {
  registry: Registry;
  stores: Stores;
  version: string;
  listen?: string;
  token?: string;
  log?: (line: string) => void;
  /** Write ~/.sayagain/daemon.json so the shim and CLI can find this daemon. Default true. */
  writeInfo?: boolean;
  /** How long a POST may wait for its response (holds can take minutes). */
  responseTimeoutMs?: number;
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [hostRaw, portRaw] = (
    options.listen ??
    options.registry.daemon?.listen ??
    "127.0.0.1:7777"
  ).split(":");
  const host = hostRaw || "127.0.0.1";
  const port = Number(portRaw ?? "7777");
  const token = options.token ?? randomBytes(24).toString("base64url");
  const holds = new HoldQueue();
  const boundaries = new Map<string, Boundary>();
  const sseClients = new Set<ServerResponse>();
  let sessionSeq = 0;

  const emitEvent = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  let closing = false;
  holds.on("decided", (h: { receipt: string; decision?: string }) => {
    if (h.decision && !closing) {
      try {
        options.stores.holds?.decide(h.receipt, h.decision as "approve" | "reject");
      } catch (err) {
        log(
          `sayagain: could not persist hold decision: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    emitEvent("hold-decided", { receipt: h.receipt, decision: h.decision });
  });

  const boundaryFor = (name: string): Boundary | undefined => {
    const existing = boundaries.get(name);
    if (existing) return existing;
    const config: ServerConfig | undefined = options.registry.servers[name];
    if (!config) return undefined;
    const coreOptions: ConstructorParameters<typeof Boundary>[0] = {
      name,
      upstream: () => upstreamFor(name, config, log),
      ledger: options.stores.ledger,
      ledgerKind: options.stores.kind === "memory" ? "memory" : options.stores.kind,
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
    b.on("hold", (hold) => {
      options.stores.holds?.save(hold);
      emitEvent("hold", summarizeHold(hold, process.pid));
    });
    b.on("dead-letter", (entry) => emitEvent("dead-letter", entry));
    boundaries.set(name, b);
    return b;
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const boundary = boundaryFor(name);
    if (!boundary)
      return json(res, 404, {
        error: `no server named ${name}; register it with: sayagain add ${name} -- <command>`,
      });
    if (req.method === "GET") {
      if (!(req.headers.accept ?? "").includes("text/event-stream"))
        return json(res, 405, { error: "GET needs Accept: text/event-stream" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const session: Session = {
        id: `sse-${++sessionSeq}`,
        send: (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`),
      };
      boundary.attach(session);
      req.on("close", () => boundary.detach(session));
      return;
    }
    if (req.method !== "POST")
      return json(res, 405, {
        error: "use POST with a JSON-RPC message, or GET with Accept: text/event-stream",
      });
    const body = await readBody(req);
    const msg = parseMessage(body);
    if (!msg) return json(res, 400, { error: "body is not JSON-RPC" });
    if (Array.isArray(msg)) return json(res, 400, { error: "JSON-RPC batches are not supported" });
    if (isRequest(msg)) {
      const wanted = keyOfId(msg.id);
      const session: Session = {
        id: `http-${++sessionSeq}`,
        send: (reply: JsonRpcMessage) => {
          if (isResponse(reply) && reply.id !== null && keyOfId(reply.id) === wanted) settle(reply);
        },
      };
      let settle: (reply: JsonRpcMessage) => void = () => {};
      const reply = new Promise<JsonRpcMessage | null>((resolve) => {
        settle = resolve;
        setTimeout(() => resolve(null), options.responseTimeoutMs ?? 900_000).unref();
      });
      boundary.attach(session);
      try {
        await boundary.handle(session, body);
        const out = await reply;
        if (out === null)
          return json(res, 504, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Say Again: no response within the daemon's limit" },
          });
        return json(res, 200, out);
      } finally {
        boundary.detach(session);
      }
    }
    const session: Session = { id: `http-${++sessionSeq}`, send: () => {} };
    boundary.attach(session);
    try {
      await boundary.handle(session, body);
    } finally {
      boundary.detach(session);
    }
    res.writeHead(202);
    res.end();
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
      return json(
        res,
        200,
        Object.entries(options.registry.servers).map(([name, cfg]) => {
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
      const [, receipt, decision] = decide;
      return json(res, 200, {
        receipt,
        decided: holds.decide(receipt ?? "", decision as "approve" | "reject"),
      });
    }
    if (req.method === "GET" && path === "/api/deadletters")
      return json(
        res,
        200,
        options.stores.deadLetters.list().map((d) => summarizeDeadLetter(d, process.pid)),
      );
    const replay = path.match(/^\/api\/replay\/([^/]+)$/);
    if (req.method === "POST" && replay) {
      const receipt = replay[1] ?? "";
      const body = await readBody(req);
      const args = body.trim()
        ? (JSON.parse(body) as { arguments?: unknown }).arguments
        : undefined;
      for (const b of boundaries.values()) {
        if (!b.deadLetters.get(receipt)) continue;
        const outcome = await b.replay(receipt, args);
        return json(res, 200, outcome ?? { error: "not found" });
      }
      const entry = options.stores.deadLetters.get(receipt);
      if (entry) {
        const b =
          boundaryFor(entry.upstream) ??
          [...boundaries.values()].find((x) => x.upstreamName === entry.upstream) ??
          boundaryFor(Object.keys(options.registry.servers)[0] ?? "");
        if (b) return json(res, 200, (await b.replay(receipt, args)) ?? { error: "not found" });
      }
      return json(res, 404, { error: `no dead letter ${receipt}` });
    }
    if (req.method === "GET" && path === "/api/ledger") {
      const tail = Number(url.searchParams.get("tail") ?? "100");
      return json(res, 200, options.stores.readLedger(Number.isFinite(tail) ? tail : 100));
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && path === "/api/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => void daemon.close().then(() => process.exit(0)), 50);
      return;
    }
    return json(res, 404, { error: "unknown API route" });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    void (async () => {
      try {
        if (!authorized(req, url))
          return json(res, 401, { error: "missing or wrong bearer token" });
        const mcp = url.pathname.match(/^\/mcp\/([A-Za-z0-9_.-]+)\/?$/);
        if (mcp) return await handleMcp(req, res, mcp[1] ?? "");
        if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
        return json(res, 404, { error: "not found" });
      } catch (err) {
        log(`sayagain: request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent)
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
  const daemonUrl = `http://${host}:${boundPort}`;

  for (const h of options.stores.holds?.pending() ?? []) holds.create({ ...h });

  if (options.writeInfo ?? true)
    writeDaemonInfo({
      pid: process.pid,
      host,
      port: boundPort,
      token,
      startedAt: new Date().toISOString(),
      version: options.version,
    });

  const daemon: Daemon = {
    host,
    port: boundPort,
    token,
    url: daemonUrl,
    holds,
    boundaries,
    close: async () => {
      closing = true;
      await Promise.all([...boundaries.values()].map((b) => b.close()));
      for (const res of sseClients) res.end();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      if (options.writeInfo ?? true) removeDaemonInfo();
      options.stores.close();
    },
  };
  return daemon;
}
