/**
 * An upstream reached over Streamable HTTP: every JSON-RPC message is one POST.
 * A request's response comes back as JSON, or as an SSE stream that carries
 * it; notifications get 202. Server-initiated messages arrive on the same
 * streams. Sessions are not used (the 2026-07-28 revision is stateless), but
 * an Mcp-Session-Id the server hands out is echoed back.
 */
import type { Upstream } from "./transport.js";

export interface HttpUpstreamOptions {
  url: string;
  headers?: Record<string, string>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class HttpUpstream implements Upstream {
  private lineHandlers: ((line: string) => void)[] = [];
  private closeHandlers: ((reason: string, code: number | null) => void)[] = [];
  private stopped = false;
  private sessionId: string | undefined;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HttpUpstreamOptions) {
    this.doFetch = options.fetch ?? fetch;
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
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.closeHandlers) h("stopped", null);
  }

  private emit(text: string): void {
    for (const line of text.split("\n"))
      if (line.trim()) for (const h of this.lineHandlers) h(line);
  }

  send(line: string): boolean {
    if (this.stopped) return false;
    void this.post(line).catch((err: unknown) => {
      this.options.log?.(
        `sayagain: upstream ${this.options.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Surface the failure to the caller as a JSON-RPC error so the call does not hang until the sweep.
      try {
        const msg = JSON.parse(line) as { id?: unknown };
        if (msg.id !== undefined)
          this.emit(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32000,
                message: `upstream unreachable: ${err instanceof Error ? err.message : String(err)}`,
              },
            }),
          );
      } catch {
        // not a request; nothing to answer
      }
    });
    return true;
  }

  private async post(line: string): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.options.headers ?? {}),
    };
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 120_000);
    try {
      const res = await this.doFetch(this.options.url, {
        method: "POST",
        headers,
        body: line.trimEnd(),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (res.status === 202 || res.status === 204) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        await this.readSse(res);
        return;
      }
      const text = await res.text();
      if (text.trim()) this.emit(text.trim());
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSse(res: Response): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep >= 0) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) this.emit(data);
        sep = buf.indexOf("\n\n");
      }
    }
  }
}
