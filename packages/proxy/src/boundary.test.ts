import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT,
  createState,
  describeCall,
  duplicateResponse,
  heldResponse,
  observeClientMessage,
  ownToolsListRequest,
  registerPending,
  rewriteServerMessage,
  shapeOf,
} from "./boundary.js";
import type { JsonRpcRequest } from "./jsonrpc.js";

const opts = { version: "0.2.0", ledgerKind: "memory" as const, announce: true, shim: false };
const req = (
  id: number | string,
  name: string,
  args: unknown,
  meta?: Record<string, unknown>,
): JsonRpcRequest => {
  const params: Record<string, unknown> = { name, arguments: args };
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/call", params };
};

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

describe("describeCall", () => {
  it("reads intent, task and idempotency key from _meta", () => {
    const call = describeCall(
      req(
        1,
        "search",
        { q: "x" },
        {
          "sh.sayagain/intent": "find it",
          "sh.sayagain/task": "t1",
          "sh.sayagain/idempotency-key": "k1",
        },
      ),
      "raw",
      "read-only",
      10,
      1000,
    );
    expect(call).toMatchObject({
      tool: "search",
      toolClass: "read-only",
      hasIntent: true,
      intent: "find it",
      task: "t1",
      idempotencyKey: "k1",
      argShape: ["q:string"],
      rawLine: "raw",
    });
    expect(call.receipt).toMatch(/^rcpt_/);
  });
});

describe("tools/call rewrite", () => {
  it("adds receipt and status to result._meta, produces a row, offers the result for dedupe", () => {
    const state = createState("notion");
    registerPending(
      state,
      describeCall(req(7, "search", { q: "x" }), "raw", "read-only", 100, 1000),
    );
    const { message, changed, row, remember } = rewriteServerMessage(
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
    expect(row).toMatchObject({
      tool: "search",
      upstream: "notion",
      toolClass: "read-only",
      isError: false,
      latencyMs: 250,
    });
    expect(remember?.call.tool).toBe("search");
    expect(state.pending.size).toBe(0);
  });

  it("classifies isError results, keeps them executed, does not offer them for dedupe", () => {
    const state = createState();
    registerPending(state, describeCall(req("a", "get", {}), "raw", "read-only", 10));
    const { row, remember } = rewriteServerMessage(
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
    expect(row).toMatchObject({
      isError: true,
      status: "executed",
      errorSignature: "Error: page <str> not found",
    });
    expect(remember).toBeUndefined();
  });

  it("leaves JSON-RPC errors untouched but still records them", () => {
    const state = createState();
    registerPending(state, describeCall(req(1, "get", { limit: "10" }), "raw", "write", 10));
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

  it("carries the hold decision into _meta and the row", () => {
    const state = createState();
    const call = describeCall(req(3, "delete_page", { id: 1 }), "raw", "destructive", 10);
    call.held = { reason: "destructive", decision: "approve", waitedMs: 5 };
    registerPending(state, call);
    const { message, row } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 3, result: { content: [] } },
      state,
      opts,
      10,
    );
    expect(
      (message as { result: { _meta: Record<string, unknown> } }).result._meta["sh.sayagain/held"],
    ).toEqual({ reason: "destructive", decision: "approve" });
    expect(row?.held).toEqual({ reason: "destructive", decision: "approve", waitedMs: 5 });
  });
});

describe("initialize and tools/list", () => {
  it("announces the boundary in _meta and instructions, keeps serverInfo", () => {
    const state = createState("upstream");
    observeClientMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, state);
    const { message, changed } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 0,
        result: { serverInfo: { name: "notion", version: "1" }, instructions: "Be kind." },
      },
      state,
      { ...opts, hold: "destructive" },
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
      hold: "destructive",
    });
    expect(state.upstreamName).toBe("notion");
  });

  it("swallows the reply to its own tools/list but still learns from it", () => {
    const state = createState();
    const own = ownToolsListRequest(state);
    expect(String(own.id)).toMatch(/^sayagain:tools:/);
    const { swallow, tools } = rewriteServerMessage(
      { jsonrpc: "2.0", id: own.id, result: { tools: [{ name: "y" }] } },
      state,
      opts,
      10,
    );
    expect(swallow).toBe(true);
    expect(tools).toEqual([{ name: "y" }]);
  });

  it("surfaces tools/list results for the classifier without changing them", () => {
    const state = createState();
    observeClientMessage({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, state);
    const { changed, tools } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 5, result: { tools: [{ name: "x" }] } },
      state,
      opts,
      10,
    );
    expect(changed).toBe(false);
    expect(tools).toEqual([{ name: "x" }]);
  });
});

describe("synthetic responses", () => {
  it("marks a duplicate with both receipts", () => {
    const call = describeCall(req(9, "create_page", { t: 1 }), "raw", "write", 10);
    const msg = duplicateResponse(call, "rcpt_first", {
      content: [{ type: "text", text: "ok" }],
      _meta: { a: 1 },
    });
    const meta = (msg as { result: { _meta: Record<string, unknown> } }).result._meta;
    expect(meta).toMatchObject({
      a: 1,
      "sh.sayagain/receipt": call.receipt,
      "sh.sayagain/status": "deduplicated",
      "sh.sayagain/duplicate-of": "rcpt_first",
    });
  });

  it("explains a hold and a rejection differently", () => {
    const call = describeCall(req(9, "delete_page", {}), "raw", "destructive", 10);
    const held = heldResponse(call, "destructive", 2_000_000_000_000, false) as {
      result: { isError: boolean; content: { text: string }[]; _meta: Record<string, unknown> };
    };
    expect(held.result.isError).toBe(false);
    expect(held.result.content[0]?.text).toContain("STANDBY");
    expect(held.result._meta["sh.sayagain/status"]).toBe("held");
    const rejected = heldResponse(call, "destructive", 2_000_000_000_000, true) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0]?.text).toContain("UNABLE");
  });
});
