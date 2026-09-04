/**
 * The pure part of the boundary: what to remember about a client message,
 * and how to rewrite a server response. No I/O here, so it is testable
 * without processes.
 */
import { createHash, randomBytes } from "node:crypto";
import { META, type Status, type ToolClass } from "@sayagain/sdk";
import { classifyError, type ErrorClass, guidanceFor } from "./errors.js";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from "./jsonrpc.js";
import { isRequest, isResponse } from "./jsonrpc.js";
import type { LedgerRow } from "./ledger.js";
import type { RepairChange } from "./repair.js";
import { resultText, signatureOf } from "./signature.js";

export const BOUNDARY_NAME = "sayagain";

export interface PendingCall {
  id: JsonRpcId;
  receipt: string;
  tool: string;
  toolClass: ToolClass;
  argShape: string[];
  argsHash: string;
  arguments: unknown;
  hasIntent: boolean;
  intent?: string;
  task?: string;
  idempotencyKey?: string;
  startedAt: number;
  requestBytes: number;
  /** The request line as it will be (or was) sent upstream; updated by repair. */
  rawLine: string;
  held?: { reason: string; decision?: "approve" | "reject"; waitedMs?: number };
  attempts: number;
  repairs: RepairChange[];
  replayOf?: string;
}

export interface BoundaryState {
  pending: Map<string, PendingCall>;
  initializeIds: Set<string>;
  toolsListIds: Set<string>;
  /** Request ids the boundary itself sent upstream; their replies never reach the client. */
  ownIds: Set<string>;
  ownCounter: number;
  upstreamName: string;
}

export interface BoundaryOptions {
  version: string;
  ledgerKind: "jsonl" | "memory" | "sqlite" | "postgres";
  announce: boolean;
  shim: boolean;
  hold?: string;
  rewriteErrors?: boolean;
}

export const ANNOUNCEMENT =
  "Calls to this server pass through Say Again: every result carries sh.sayagain/receipt and sh.sayagain/status in _meta, and a held call returns a text block naming the receipt.";

export const keyOf = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

export function newReceipt(now = Date.now()): string {
  return `rcpt_${now.toString(36)}${randomBytes(5).toString("hex")}`;
}

export function shapeOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  return Object.entries(input)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}`)
    .sort();
}

export const hashArgs = (input: unknown): string =>
  createHash("sha1")
    .update(JSON.stringify(input ?? null))
    .digest("hex")
    .slice(0, 16);

export function createState(upstreamName = "upstream"): BoundaryState {
  return {
    pending: new Map(),
    initializeIds: new Set(),
    toolsListIds: new Set(),
    ownIds: new Set(),
    ownCounter: 0,
    upstreamName,
  };
}

/** A tools/list request the boundary sends on its own behalf, to warm the classifier. */
export function ownToolsListRequest(state: BoundaryState): JsonRpcRequest {
  const id = `sayagain:tools:${++state.ownCounter}`;
  state.ownIds.add(keyOf(id));
  state.toolsListIds.add(keyOf(id));
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

/** An id for a request the boundary sends on its own behalf (replay). */
export function ownId(state: BoundaryState, kind: string): string {
  const id = `sayagain:${kind}:${++state.ownCounter}`;
  state.ownIds.add(keyOf(id));
  return id;
}

/** Build the boundary's record of a tools/call request. Does not register it. */
export function describeCall(
  msg: JsonRpcRequest,
  rawLine: string,
  toolClass: ToolClass,
  bytes: number,
  now = Date.now(),
): PendingCall {
  const params = msg.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const call: PendingCall = {
    id: msg.id,
    receipt: newReceipt(now),
    tool: typeof params.name === "string" ? params.name : "",
    toolClass,
    argShape: shapeOf(params.arguments),
    argsHash: hashArgs(params.arguments),
    arguments: params.arguments,
    hasIntent: typeof meta[META.intent] === "string",
    startedAt: now,
    requestBytes: bytes,
    rawLine,
    attempts: 1,
    repairs: [],
  };
  if (typeof meta[META.intent] === "string") call.intent = meta[META.intent] as string;
  if (typeof meta[META.task] === "string") call.task = meta[META.task] as string;
  if (typeof meta[META.idempotencyKey] === "string")
    call.idempotencyKey = meta[META.idempotencyKey] as string;
  return call;
}

/** Track initialize and tools/list request ids so their responses can be recognised. */
export function observeClientMessage(
  msg: JsonRpcMessage,
  state: BoundaryState,
): "initialize" | "tools/list" | "tools/call" | null {
  if (!isRequest(msg)) return null;
  if (msg.method === "initialize") {
    state.initializeIds.add(keyOf(msg.id));
    return "initialize";
  }
  if (msg.method === "tools/list") {
    state.toolsListIds.add(keyOf(msg.id));
    return "tools/list";
  }
  if (msg.method === "tools/call") return "tools/call";
  return null;
}

export function registerPending(state: BoundaryState, call: PendingCall): void {
  state.pending.set(keyOf(call.id), call);
}

/** Look up the pending call for a response without consuming it. */
export function pendingFor(msg: JsonRpcMessage, state: BoundaryState): PendingCall | undefined {
  if (!isResponse(msg) || msg.id === null) return undefined;
  return state.pending.get(keyOf(msg.id));
}

/** What a failed response tells the boundary, before it decides to retry, repair, hold or finish. */
export interface Failure {
  errorClass: ErrorClass;
  signature: string;
  text: string;
  rpcCode?: number;
}

export function failureOf(msg: JsonRpcMessage): Failure | null {
  if (!isResponse(msg)) return null;
  if (msg.error) {
    return {
      errorClass: classifyError(msg.error.message, msg.error.code),
      signature: signatureOf(msg.error.message),
      text: msg.error.message,
      rpcCode: msg.error.code,
    };
  }
  if (
    typeof msg.result === "object" &&
    msg.result !== null &&
    (msg.result as { isError?: unknown }).isError === true
  ) {
    const text = resultText(msg.result);
    return { errorClass: classifyError(text), signature: signatureOf(text), text };
  }
  return null;
}

/** A copy of the request line with new arguments (and optionally a new id), for repair and replay. */
export function withArguments(rawLine: string, args: unknown, id?: JsonRpcId): string {
  const msg = JSON.parse(rawLine) as JsonRpcRequest;
  const params = { ...(msg.params ?? {}), arguments: args };
  return JSON.stringify({ ...msg, ...(id !== undefined ? { id } : {}), params });
}

export function baseRow(
  call: PendingCall,
  upstream: string,
  status: Status,
  responseBytes: number,
  now: number,
): LedgerRow {
  const row: LedgerRow = {
    receipt: call.receipt,
    ts: new Date(call.startedAt).toISOString(),
    upstream,
    method: "tools/call",
    tool: call.tool,
    toolClass: call.toolClass,
    argShape: call.argShape,
    argsHash: call.argsHash,
    hasIntent: call.hasIntent,
    status,
    isError: false,
    latencyMs: Math.max(0, now - call.startedAt),
    requestBytes: call.requestBytes,
    responseBytes,
  };
  if (call.task !== undefined) row.task = call.task;
  if (call.held) row.held = { ...call.held };
  if (call.attempts > 1) row.attempts = call.attempts;
  if (call.repairs.length) row.repairs = call.repairs.map((c) => ({ path: c.path, rule: c.rule }));
  if (call.replayOf !== undefined) row.replayOf = call.replayOf;
  return row;
}

export interface Rewrite {
  message: JsonRpcMessage;
  changed: boolean;
  /** True when the message answers a boundary-owned request and must not be forwarded. */
  swallow?: boolean;
  row?: LedgerRow;
  /** Set when a tools/list result was seen, so the caller can learn annotations. */
  tools?: unknown;
  /** Set when a tools/call succeeded, so the caller can remember it for dedupe. */
  remember?: { call: PendingCall; result: unknown };
  /** The call this response completed, when it was a tools/call. */
  call?: PendingCall;
}

/**
 * Rewrite a server-to-client message. Only two shapes change: a tools/call
 * response gains receipt and status in result._meta (plus guidance on a
 * failure); an initialize response gains the boundary announcement.
 * Everything else passes through untouched.
 */
export function rewriteServerMessage(
  msg: JsonRpcMessage,
  state: BoundaryState,
  opts: BoundaryOptions,
  bytes: number,
  now = Date.now(),
): Rewrite {
  if (!isResponse(msg) || msg.id === null) return { message: msg, changed: false };
  const key = keyOf(msg.id);

  if (state.toolsListIds.has(key)) {
    state.toolsListIds.delete(key);
    const own = state.ownIds.delete(key);
    const tools =
      typeof msg.result === "object" && msg.result !== null
        ? (msg.result as { tools?: unknown }).tools
        : undefined;
    const out: Rewrite = { message: msg, changed: false };
    if (own) out.swallow = true;
    if (tools !== undefined) out.tools = tools;
    return out;
  }

  if (state.initializeIds.has(key)) {
    state.initializeIds.delete(key);
    if (msg.error || typeof msg.result !== "object" || msg.result === null)
      return { message: msg, changed: false };
    const result = { ...(msg.result as Record<string, unknown>) };
    const serverInfo = result.serverInfo as { name?: unknown } | undefined;
    if (serverInfo && typeof serverInfo.name === "string") state.upstreamName = serverInfo.name;
    const meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}) };
    const boundary: Record<string, unknown> = {
      name: BOUNDARY_NAME,
      version: opts.version,
      upstream: state.upstreamName,
      ledger: opts.ledgerKind,
      shim: opts.shim,
    };
    if (opts.hold !== undefined) boundary.hold = opts.hold;
    meta[META.boundary] = boundary;
    result._meta = meta;
    if (opts.announce) {
      const existing = typeof result.instructions === "string" ? result.instructions.trimEnd() : "";
      result.instructions = existing ? `${existing}\n\n${ANNOUNCEMENT}` : ANNOUNCEMENT;
    }
    return { message: { ...msg, result }, changed: true };
  }

  const call = state.pending.get(key);
  if (!call) return { message: msg, changed: false };
  state.pending.delete(key);
  const own = state.ownIds.delete(key);

  // A failure after the boundary already tried something is exhausted: dead-lettered.
  const tried = call.attempts > 1 || call.repairs.length > 0;
  const failure = failureOf(msg);
  const status: Status =
    failure && tried && call.replayOf === undefined ? "dead-lettered" : "executed";
  const row = baseRow(call, state.upstreamName, status, bytes, now);
  const swallow = own ? { swallow: true } : {};

  if (msg.error) {
    row.isError = true;
    row.errorCode = msg.error.code;
    row.errorSignature = signatureOf(msg.error.message);
    if (failure) row.errorClass = failure.errorClass;
    // A JSON-RPC error has no result to carry _meta; the ledger keeps the receipt.
    return { message: msg, changed: false, row, call, ...swallow };
  }

  if (typeof msg.result !== "object" || msg.result === null)
    return { message: msg, changed: false, row, call, ...swallow };
  const result = { ...(msg.result as Record<string, unknown>) };
  if (failure) {
    row.isError = true;
    row.errorSignature = failure.signature;
    row.errorClass = failure.errorClass;
    if (opts.rewriteErrors ?? true) {
      const content = Array.isArray(result.content) ? [...result.content] : [];
      content.push({
        type: "text",
        text: guidanceFor({
          errorClass: failure.errorClass,
          attempts: call.attempts,
          repaired: call.repairs.length > 0,
          receipt: call.receipt,
          status: status === "dead-lettered" ? "dead-lettered" : "executed",
          tool: call.tool,
        }),
      });
      result.content = content;
    }
  }
  const meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}) };
  meta[META.receipt] = call.receipt;
  meta[META.status] = status;
  if (call.held)
    meta[META.held] = { reason: call.held.reason, decision: call.held.decision ?? null };
  if (call.repairs.length)
    meta[META.repair] = {
      kind: call.repairs.every((c) => c.rule === "rename") ? "rename" : "coerce",
      changes: call.repairs,
    };
  if (call.replayOf !== undefined) meta[META.replayOf] = call.replayOf;
  result._meta = meta;
  const message = { ...msg, result };
  return row.isError
    ? { message, changed: true, row, call, ...swallow }
    : { message, changed: true, row, call, remember: { call, result }, ...swallow };
}

/** The response for a duplicate: the first result again, marked so the agent can tell. */
export function duplicateResponse(
  call: PendingCall,
  firstReceipt: string,
  firstResult: unknown,
): JsonRpcMessage {
  const result =
    typeof firstResult === "object" && firstResult !== null
      ? { ...(firstResult as Record<string, unknown>) }
      : {};
  const meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}) };
  meta[META.receipt] = call.receipt;
  meta[META.status] = "deduplicated";
  meta[META.duplicateOf] = firstReceipt;
  result._meta = meta;
  return { jsonrpc: "2.0", id: call.id, result };
}

/** The response for a call that is still held after the wait, or was rejected. */
export function heldResponse(
  call: PendingCall,
  reason: string,
  expiresAt: number,
  rejected: boolean,
): JsonRpcMessage {
  const text = rejected
    ? `UNABLE: an operator rejected this call. Receipt ${call.receipt}. Do not retry it; tell the user.`
    : `STANDBY: this call is held for approval and has not been executed. Receipt ${call.receipt}. Reason: ${reason}. It expires at ${new Date(expiresAt).toISOString()} unless an operator approves it (sayagain approve ${call.receipt}). Continue with other work or tell the user.`;
  const held: Record<string, unknown> = { reason, expiresAt: new Date(expiresAt).toISOString() };
  if (rejected) held.decision = "reject";
  return {
    jsonrpc: "2.0",
    id: call.id,
    result: {
      content: [{ type: "text", text }],
      isError: rejected,
      _meta: { [META.receipt]: call.receipt, [META.status]: "held", [META.held]: held },
    },
  };
}
