import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT,
  createState,
  observeClientMessage,
  rewriteServerMessage,
  shapeOf,
} from "./boundary.js";

const opts = { version: "0.1.0", ledgerKind: "memory" as const, announce: true, shim: false };

describe("shapeOf", () => {
  it("records keys and types, never values", () => {
    expect(shapeOf({ b: 1, a: "x", c: [1], d: null })).toEqual([
      "a:string",
      "b:number",
      "c:array",
      "d:null",
    ]);
    expect(shapeOf("nope")).toEqual([]);
  });
});

describe("tools/call rewrite", () => {
  it("adds receipt and status to result._meta and produces a ledger row", () => {
    const state = createState("notion");
    observeClientMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { q: "x" },
          _meta: { "sh.sayagain/intent": "find the page", "sh.sayagain/task": "t1" },
        },
      },
      state,
      100,
      1000,
    );
    const { message, changed, row } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 7, result: { content: [], _meta: { keep: 1 } } },
      state,
      opts,
      50,
      1250,
    );
    expect(changed).toBe(true);
    const result = (message as { result: { _meta: Record<string, unknown> } }).result;
    expect(result._meta.keep).toBe(1);
    expect(result._meta["sh.sayagain/status"]).toBe("executed");
    expect(String(result._meta["sh.sayagain/receipt"])).toMatch(/^rcpt_/);
    expect(row).toMatchObject({
      tool: "search",
      upstream: "notion",
      hasIntent: true,
      task: "t1",
      isError: false,
      latencyMs: 250,
      argShape: ["q:string"],
    });
    expect(state.pending.size).toBe(0);
  });

  it("classifies isError results and keeps them executed", () => {
    const state = createState();
    observeClientMessage(
      { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "get", arguments: {} } },
      state,
      10,
    );
    const { row } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: "a",
        result: {
          isError: true,
          content: [{ type: "text", text: "Error: page 'abc-123' not found" }],
        },
      },
      state,
      opts,
      10,
    );
    expect(row?.isError).toBe(true);
    expect(row?.status).toBe("executed");
    expect(row?.errorSignature).toBe("Error: page <str> not found");
  });

  it("leaves JSON-RPC errors untouched but still records them", () => {
    const state = createState();
    observeClientMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get", arguments: { limit: "10" } },
      },
      state,
      10,
    );
    const { changed, row, message } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid params: limit must be a number" },
      },
      state,
      opts,
      10,
    );
    expect(changed).toBe(false);
    expect((message as { error: unknown }).error).toBeDefined();
    expect(row).toMatchObject({ isError: true, errorCode: -32602 });
  });

  it("ignores responses it did not see the request for", () => {
    const state = createState();
    const { changed, row } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 99, result: {} },
      state,
      opts,
      5,
    );
    expect(changed).toBe(false);
    expect(row).toBeUndefined();
  });
});

describe("initialize rewrite", () => {
  it("announces the boundary in _meta and instructions, keeps serverInfo", () => {
    const state = createState("upstream");
    observeClientMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, state, 10);
    const { message, changed } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 0,
        result: { serverInfo: { name: "notion", version: "1" }, instructions: "Be kind." },
      },
      state,
      opts,
      10,
    );
    expect(changed).toBe(true);
    const result = (message as { result: Record<string, unknown> }).result;
    expect(result.serverInfo).toEqual({ name: "notion", version: "1" });
    expect(result.instructions).toBe(`Be kind.\n\n${ANNOUNCEMENT}`);
    expect((result._meta as Record<string, unknown>)["sh.sayagain/boundary"]).toMatchObject({
      name: "sayagain",
      upstream: "notion",
      ledger: "memory",
    });
    expect(state.upstreamName).toBe("notion");
  });

  it("can stay silent in instructions", () => {
    const state = createState();
    observeClientMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, state, 10);
    const { message } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "x" } } },
      state,
      { ...opts, announce: false },
      10,
    );
    expect((message as { result: Record<string, unknown> }).result.instructions).toBeUndefined();
  });
});
