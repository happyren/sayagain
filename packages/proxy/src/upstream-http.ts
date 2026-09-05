/**
 * An upstream reached over Streamable HTTP: every JSON-RPC message is one POST.
 * A request's response comes back as JSON, or as an SSE stream that carries
 * it; notifications get 202. After initialize, a GET stream carries the
 * messages the server initiates. An Mcp-Session-Id the server hands out is
 * echoed back; when the server forgets it (404), the boundary is told the
 * upstream closed so it initializes again.
 */
import type { Upstream } from "./transport.js";

export interface HttpUpstreamOptions {
  url: string;
  headers?: Record<string, string>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** How long to wait for a response's headers. The body (an SSE stream) is not limited. */
  headerTimeoutMs?: number;
  /** Open a GET stream for server-initiated messages after initialize. Default true. */
  stream?: boolean;
}

export class HttpUpstream implements Upstream {
  private lineHandlers: ((line: string) => void)[] = [];
  private closeHandlers: ((reason: string, code: number | null) => void)[] = [];
  private stopped = false;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private streamController: AbortController | undefined;
  private readonly doFetch: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(private readonly options: HttpUpstreamOptions) {
    this.doFetch = options.fetch ?? fetch;
    const user: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers ?? {})) user[k.toLowerCase()] = v;
    this.baseHeaders = user;
  }

  get ready(): boolean {
    return !this.stopped;
  }
  onLine(cb: (line: string) => void): void {
    this.lineHandlers.push(cb);
  }
  onClose(cb: (reason: string, code: number | null) => void): void {
    this.closeHandlers.push(cb);
  }
  async start(): Promise<void> {}
  stop(): void {
    this.finish("stopped");
  }

  private finish(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.streamController?.abort();
    for (const h of this.closeHandlers) h(reason, null);
  }

  /** Hand a body to the boundary: one JSON document, or newline-delimited documents. */
  private emit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      JSON.parse(trimmed);
      for (const h of this.lineHandlers) h(trimmed);
      return;
    } catch {
      // not one document; maybe several, one per line
    }
    for (const line of trimmed.split(/\r?\n/))
      if (line.trim()) for (const h of this.lineHandlers) h(line);
  }

  private headersFor(line: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    try {
      const parsed = JSON.parse(line) as { method?: string; params?: { name?: string } };
      if (typeof parsed.method === "string") {
        headers["mcp-method"] = parsed.method;
        if (parsed.method === "tools/call" && typeof parsed.params?.name === "string")
          headers["mcp-name"] = parsed.params.name;
      }
    } catch {
      // send as-is
    }
    return { ...headers, ...this.baseHeaders };
  }

  send(line: string): boolean {
    if (this.stopped) return false;
    void this.post(line).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.options.log?.(`sayagain: upstream ${this.options.url}: ${detail}`);
      // Surface the failure to the caller as a JSON-RPC error so the call does not hang until the sweep.
      try {
        const msg = JSON.parse(line) as { id?: unknown };
        if (msg.id !== undefined)
          this.emit(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32000, message: `upstream unreachable: ${detail}` },
            }),
          );
      } catch {
        // not a request; nothing to answer
      }
    });
    return true;
  }

  private async post(line: string): Promise<void> {
    let isInitialize = false;
    try {
      isInitialize = (JSON.parse(line) as { method?: string }).method === "initialize";
    } catch {
      // not a request
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("no response headers in time")),
      this.options.headerTimeoutMs ?? 120_000,
    );
    let res: Response;
    try {
      res = await this.doFetch(this.options.url, {
        method: "POST",
        headers: this.headersFor(line),
        body: line.trimEnd(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return;
    if (res.status === 404 && this.sessionId && !isInitialize) {
      // The server forgot our session: the boundary must initialize again.
      this.sessionId = undefined;
      this.finish("session expired");
      throw new Error("HTTP 404: session expired");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const onMessage = (text: string) => {
      if (isInitialize) this.noteInitialize(text);
      this.emit(text);
    };
    if (type.includes("text/event-stream")) {
      await readSse(res, onMessage);
      return;
    }
    onMessage(await res.text());
  }

  private noteInitialize(text: string): void {
    try {
      const msg = JSON.parse(text) as { result?: { protocolVersion?: unknown } };
      if (typeof msg.result?.protocolVersion === "string") {
        this.protocolVersion = msg.result.protocolVersion;
        if (this.options.stream ?? true) this.openStream();
      }
    } catch {
      // not the initialize result
    }
  }

  /** The GET stream for server-initiated messages; reconnects with backoff until stopped or refused. */
  private openStream(): void {
    if (this.streamController) return;
    const controller = new AbortController();
    this.streamController = controller;
    void (async () => {
      let backoff = 1000;
      while (!this.stopped && !controller.signal.aborted) {
        const started = Date.now();
        try {
          const headers: Record<string, string> = { accept: "text/event-stream" };
          if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
          if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
          const res = await this.doFetch(this.options.url, {
            method: "GET",
            headers: { ...headers, ...this.baseHeaders },
            signal: controller.signal,
          });
          if (res.status === 405 || res.status === 404) {
            if (res.body) await res.body.cancel();
            return; // the server does not offer a stream (or the session is gone; a POST will notice)
          }
          if (res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream"))
            await readSse(res, (text) => this.emit(text));
          else if (res.body) await res.body.cancel();
        } catch {
          // fall through to the backoff
        }
        if (this.stopped || controller.signal.aborted) return;
        backoff = Date.now() - started > 30_000 ? 1000 : Math.min(backoff * 2, 30_000);
        await new Promise((r) => setTimeout(r, backoff).unref());
      }
    })();
  }
}

/** Read an SSE body, calling `onData` with the data of each event. Tolerates CRLF and flushes at EOF. */
export async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (event: string) => {
    const data = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    let sep = buf.indexOf("\n\n");
    while (sep >= 0) {
      dispatch(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
      sep = buf.indexOf("\n\n");
    }
  }
  buf += decoder.decode();
  if (buf.trim()) dispatch(buf);
}
