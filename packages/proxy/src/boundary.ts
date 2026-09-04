/**
 * The pure part of the boundary: what to remember about a client message,
 * and how to rewrite a server response. No I/O here, so it is testable
 * without processes.
 */
import { createHash, randomBytes } from "node:crypto";
import { META, type Status } from "@sayagain/sdk";
import type { JsonRpcId, JsonRpcMessage } from "./jsonrpc.js";
import { isRequest, isResponse } from "./jsonrpc.js";
import type { LedgerRow } from "./ledger.js";
import { resultText, signatureOf } from "./signature.js";

export const BOUNDARY_NAME = "sayagain";

export interface PendingCall {
  id: JsonRpcId;
  receipt: string;
  tool: string;
  argShape: string[];
  argsHash: string;
  hasIntent: boolean;
  task?: string;
  startedAt: number;
  requestBytes: number;
}

export interface BoundaryState {
  pending: Map<string, PendingCall>;
  initializeIds: Set<string>;
  upstreamName: string;
}

export interface BoundaryOptions {
  version: string;
  ledgerKind: "jsonl" | "memory" | "sqlite" | "postgres";
  announce: boolean;
  shim: boolean;
}

export const ANNOUNCEMENT =
  "Calls to this server pass through Say Again: every result carries sh.sayagain/receipt and sh.sayagain/status in _meta, and a held call returns a text block naming the receipt.";

const keyOf = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

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
  return { pending: new Map(), initializeIds: new Set(), upstreamName };
}

/** Record what the boundary needs from a client-to-server message. Never mutates it. */
export function observeClientMessage(
  msg: JsonRpcMessage,
  state: BoundaryState,
  bytes: number,
  now = Date.now(),
): void {
  if (!isRequest(msg)) return;
  if (msg.method === "initialize") {
    state.initializeIds.add(keyOf(msg.id));
    return;
  }
  if (msg.method !== "tools/call") return;
  const params = msg.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const task = meta[META.task];
  const call: PendingCall = {
    id: msg.id,
    receipt: newReceipt(now),
    tool: typeof params.name === "string" ? params.name : "",
    argShape: shapeOf(params.arguments),
    argsHash: hashArgs(params.arguments),
    hasIntent: typeof meta[META.intent] === "string",
    startedAt: now,
    requestBytes: bytes,
  };
  if (typeof task === "string") call.task = task;
  state.pending.set(keyOf(msg.id), call);
}

export interface Rewrite {
  message: JsonRpcMessage;
  changed: boolean;
  row?: LedgerRow;
}

/**
 * Rewrite a server-to-client message. Only two shapes change: a tools/call
 * response gains receipt and status in result._meta; an initialize response
 * gains the boundary announcement. Everything else passes through untouched.
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

  if (state.initializeIds.has(key)) {
    state.initializeIds.delete(key);
    if (msg.error || typeof msg.result !== "object" || msg.result === null)
      return { message: msg, changed: false };
    const result = { ...(msg.result as Record<string, unknown>) };
    const serverInfo = result.serverInfo as { name?: unknown } | undefined;
    if (serverInfo && typeof serverInfo.name === "string") state.upstreamName = serverInfo.name;
    const meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}) };
    meta[META.boundary] = {
      name: BOUNDARY_NAME,
      version: opts.version,
      upstream: state.upstreamName,
      ledger: opts.ledgerKind,
      shim: opts.shim,
    };
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

  const status: Status = "executed";
  const row: LedgerRow = {
    receipt: call.receipt,
    ts: new Date(call.startedAt).toISOString(),
    upstream: state.upstreamName,
    method: "tools/call",
    tool: call.tool,
    argShape: call.argShape,
    argsHash: call.argsHash,
    hasIntent: call.hasIntent,
    status,
    isError: false,
    latencyMs: Math.max(0, now - call.startedAt),
    requestBytes: call.requestBytes,
    responseBytes: bytes,
  };
  if (call.task !== undefined) row.task = call.task;

  if (msg.error) {
    row.isError = true;
    row.errorCode = msg.error.code;
    row.errorSignature = signatureOf(msg.error.message ?? "");
    // A JSON-RPC error has no result to carry _meta; the ledger keeps the receipt.
    return { message: msg, changed: false, row };
  }

  if (typeof msg.result !== "object" || msg.result === null)
    return { message: msg, changed: false, row };
  const result = { ...(msg.result as Record<string, unknown>) };
  if (result.isError === true) {
    row.isError = true;
    row.errorSignature = signatureOf(resultText(result));
  }
  const meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}) };
  meta[META.receipt] = call.receipt;
  meta[META.status] = status;
  result._meta = meta;
  return { message: { ...msg, result }, changed: true, row };
}
