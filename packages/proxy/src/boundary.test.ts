import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT,
  canonicalJson,
  createState,
  describeCall,
  duplicateResponse,
  failureOf,
  hashArgs,
  heldResponse,
  observeClientMessage,
  ownToolsListRequest,
  registerPending,
  rewriteServerMessage,
  shapeOf,
} from "./boundary.js";
import type { JsonRpcRequest } from "./jsonrpc.js";

const opts = { version: "0.3.0", ledgerKind: "memory" as const, announce: true, shim: false };
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

describe("shapes and hashes", () => {
  it("records keys and types, never values", () => {
    expect(shapeOf({ b: 1, a: "x", c: [1], d: null })).toEqual([
      "a:string",
      "b:number",
      "c:array",
      "d:null",
    ]);
    expect(shapeOf("nope")).toEqual([]);
  });
  it("hashes independent of key order at every level", () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [1, { e: 3 }] } })).toBe(
      hashArgs({ b: { d: [1, { e: 3 }], c: 2 }, a: 1 }),
    );
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1,"b":null}');
  });
});

describe("describeCall", () => {
  it("reads intent, task and idempotency key from _meta and keeps the client's hash", () => {
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
    expect(call.clientArgsHash).toBe(call.argsHash);
  });
});

describe("failureOf", () => {
  it("survives errors without a message", () => {
    expect(failureOf({ jsonrpc: "2.0", id: 1, error: { code: -32000 } as never })).toMatchObject({
      errorClass: "other",
      signature: "",
    });
    expect(
      failureOf({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: 7 } as never })
        ?.errorClass,
    ).toBe("coercible");
  });
});

describe("tools/call rewrite", () => {
  it("adds receipt and status, produces a row, offers the result for dedupe", () => {
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
    expect(row).toMatchObject({ tool: "search", upstream: "notion", latencyMs: 250 });
    expect(remember?.call.tool).toBe("search");
  });

  it("reports repaired when arguments changed and the call succeeded", () => {
    const state = createState();
    const call = describeCall(req(2, "get", {}), "raw", "read-only", 10);
    call.repairs = [{ path: "/limit", rule: "string-to-number", from: "1", to: 1 }];
    registerPending(state, call);
    const { message, row } = rewriteServerMessage(
      { jsonrpc: "2.0", id: 2, result: { content: [] } },
      state,
      opts,
      10,
    );
    expect(
      (message as { result: { _meta: Record<string, unknown> } }).result._meta[
        "sh.sayagain/status"
      ],
    ).toBe("repaired");
    expect(row?.status).toBe("repaired");
  });

  it("puts the receipt into error.data on JSON-RPC errors and records them", () => {
    const state = createState();
    registerPending(state, describeCall(req(1, "get", { limit: "10" }), "raw", "write", 10));
    const { changed, row, message } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32602,
          message: "Invalid params: limit must be a number",
          data: { hint: 1 },
        },
      },
      state,
      opts,
      10,
    );
    expect(changed).toBe(true);
    expect((message as { error: { data: Record<string, unknown> } }).error.data).toMatchObject({
      hint: 1,
      "sh.sayagain/status": "executed",
    });
    expect(row).toMatchObject({ isError: true, errorCode: -32602, errorClass: "coercible" });
  });

  it("dead-letters a failure after an approved hold", () => {
    const state = createState();
    const call = describeCall(req(3, "delete_page", { id: 1 }), "raw", "destructive", 10);
    call.held = { reason: "destructive", mode: "pre", decision: "approve", waitedMs: 5 };
    registerPending(state, call);
    const { row } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        result: { isError: true, content: [{ type: "text", text: "Error: Request timed out" }] },
      },
      state,
      opts,
      10,
    );
    expect(row?.status).toBe("dead-lettered");
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

describe("initialize and tools/list", () => {
  it("announces the boundary in _meta and instructions, keeps serverInfo", () => {
    const state = createState("upstream");
    observeClientMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, state);
    const { message } = rewriteServerMessage(
      {
        jsonrpc: "2.0",
        id: 0,
        result: { serverInfo: { name: "notion", version: "1" }, instructions: "Be kind." },
      },
      state,
      { ...opts, hold: "destructive" },
      10,
    );
    const result = (message as { result: Record<string, unknown> }).result;
    expect(result.serverInfo).toEqual({ name: "notion", version: "1" });
    expect(result.instructions).toBe(`Be kind.\n\n${ANNOUNCEMENT}`);
    expect((result._meta as Record<string, unknown>)["sh.sayagain/boundary"]).toMatchObject({
      upstream: "notion",
      hold: "destructive",
    });
  });

  it("swallows the reply to its own tools/list, learns from it, or reports a probe without tools", () => {
    const state = createState();
    const own = ownToolsListRequest(state);
    const { swallow, tools } = rewriteServerMessage(
      { jsonrpc: "2.0", id: own.id, result: { tools: [{ name: "y" }] } },
      state,
      opts,
      10,
    );
    expect(swallow).toBe(true);
    expect(tools).toEqual([{ name: "y" }]);
    const own2 = ownToolsListRequest(state);
    const r2 = rewriteServerMessage(
      { jsonrpc: "2.0", id: own2.id, error: { code: -32601, message: "no" } },
      state,
      opts,
      10,
    );
    expect(r2).toMatchObject({ swallow: true, probed: true });
  });
});

describe("synthetic responses", () => {
  it("marks a duplicate with both receipts", () => {
    const call = describeCall(req(9, "create_page", { t: 1 }), "raw", "write", 10);
    const msg = duplicateResponse(call, "rcpt_first", {
      content: [{ type: "text", text: "ok" }],
      _meta: { a: 1 },
    });
    expect((msg as { result: { _meta: Record<string, unknown> } }).result._meta).toMatchObject({
      a: 1,
      "sh.sayagain/status": "deduplicated",
      "sh.sayagain/duplicate-of": "rcpt_first",
    });
  });

  it("explains each hold mode differently", () => {
    const call = describeCall(req(9, "delete_page", {}), "raw", "destructive", 10);
    const pre = heldResponse(call, "destructive", 2_000_000_000_000, {
      rejected: false,
      mode: "pre",
    }) as { result: { content: { text: string }[] } };
    expect(pre.result.content[0]?.text).toContain("has not been executed");
    const unknown = heldResponse(call, "r", 2_000_000_000_000, {
      rejected: false,
      mode: "unknown-outcome",
      failure: { errorClass: "retryable", signature: "Error: Request timed out", text: "" },
    }) as { result: { content: { text: string }[]; _meta: Record<string, unknown> } };
    expect(unknown.result.content[0]?.text).toContain("outcome is unknown");
    expect(unknown.result.content[0]?.text).toContain("Do not repeat the call");
    expect(unknown.result._meta["sh.sayagain/held"]).toMatchObject({
      mode: "unknown-outcome",
      attemptError: "Error: Request timed out",
    });
    const repaired = heldResponse(call, "r", 2_000_000_000_000, {
      rejected: true,
      mode: "repaired",
      repairs: [{ path: "/limit", rule: "string-to-number" }],
    }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(repaired.result.isError).toBe(true);
    expect(repaired.result.content[0]?.text).toContain("/limit string-to-number");
  });
});
