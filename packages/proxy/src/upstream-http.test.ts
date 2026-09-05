import { describe, expect, it } from "vitest";
import { HttpUpstream } from "./upstream-http.js";

type Reply = { status?: number; headers?: Record<string, string>; body?: string };
type Seen = { method: string; headers: Record<string, string>; body: string };

function fakeFetch(handler: (seen: Seen) => Reply | Promise<Reply>) {
  const calls: Seen[] = [];
  const doFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const seen: Seen = { method: init?.method ?? "GET", headers, body: String(init?.body ?? "") };
    calls.push(seen);
    const reply = await handler(seen);
    return new Response(reply.body ?? null, {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as typeof fetch;
  return { calls, doFetch };
}

const collect = (up: HttpUpstream) => {
  const lines: string[] = [];
  up.onLine((l) => lines.push(l));
  return lines;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("HttpUpstream", () => {
  it("posts with Mcp-Method/Mcp-Name, returns a pretty-printed JSON body as one message, and 202 for notifications", async () => {
    const { calls, doFetch } = fakeFetch((seen) =>
      seen.headers["mcp-method"] === "tools/call"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }, null, 2),
          }
        : { status: 202 },
    );
    const up = new HttpUpstream({
      url: "http://x/mcp",
      fetch: doFetch,
      stream: false,
      headers: { Authorization: "Bearer t", "Content-Type": "application/json; charset=utf-8" },
    });
    const lines = collect(up);
    up.send(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } })}\n`,
    );
    up.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await tick();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: 1, result: { ok: true } });
    expect(calls[0]?.headers).toMatchObject({
      "mcp-method": "tools/call",
      "mcp-name": "echo",
      authorization: "Bearer t",
      "content-type": "application/json; charset=utf-8",
    });
  });

  it("reads SSE responses with CRLF framing and flushes the last event at EOF", async () => {
    const { doFetch } = fakeFetch(() => ({
      headers: { "content-type": "text/event-stream" },
      body: `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}`,
    }));
    const up = new HttpUpstream({ url: "http://x/mcp", fetch: doFetch, stream: false });
    const lines = collect(up);
    up.send(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`);
    await tick();
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
  });

  it("answers a failed POST with a retryable JSON-RPC error carrying the request id", async () => {
    const { doFetch } = fakeFetch(() => ({ status: 500 }));
    const up = new HttpUpstream({
      url: "http://x/mcp",
      fetch: doFetch,
      stream: false,
      log: () => {},
    });
    const lines = collect(up);
    up.send(`${JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" })}\n`);
    await tick();
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      id: "a",
      error: { code: -32000, message: "upstream unreachable: HTTP 500" },
    });
  });

  it("echoes the session id, sends the negotiated protocol version, opens the GET stream, and closes on 404", async () => {
    let gets = 0;
    const { calls, doFetch } = fakeFetch((seen) => {
      if (seen.method === "GET") {
        gets++;
        return {
          headers: { "content-type": "text/event-stream" },
          body: `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        };
      }
      if (seen.headers["mcp-method"] === "initialize")
        return {
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            result: {
              protocolVersion: "2026-07-28",
              capabilities: {},
              serverInfo: { name: "h", version: "1" },
            },
          }),
        };
      if (seen.headers["mcp-session-id"] === "sess-1") return { status: 404 };
      return { status: 202 };
    });
    const up = new HttpUpstream({ url: "http://x/mcp", fetch: doFetch, log: () => {} });
    const lines = collect(up);
    const closes: string[] = [];
    up.onClose((reason) => closes.push(reason));
    up.send(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
    await tick();
    expect(gets).toBe(1);
    expect(lines.some((l) => l.includes("list_changed"))).toBe(true);
    up.send(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await tick();
    const post = calls.find((c) => c.headers["mcp-method"] === "tools/list");
    expect(post?.headers).toMatchObject({
      "mcp-session-id": "sess-1",
      "mcp-protocol-version": "2026-07-28",
    });
    expect(closes).toEqual(["session expired"]);
    expect(up.ready).toBe(false);
    expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ id: 2, error: { code: -32000 } });
  });
});
