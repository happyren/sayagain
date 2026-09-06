/**
 * The pure part of the boundary: what to remember about a client message,
 * and how to rewrite a server response. No I/O here, so it is testable
 * without processes.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { META, type Status, type ToolClass, type VerifyDeclaration } from "@sayagain/sdk";
import { classifyError, type ErrorClass, guidanceFor } from "./errors.js";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import { isRequest, isResponse } from "./jsonrpc.js";
import type { LedgerRow } from "./ledger.js";
import type { RepairChange } from "./repair.js";
import { resultText, signatureOf } from "./signature.js";

export const BOUNDARY_NAME = "sayagain";

export type HoldMode = "pre" | "unknown-outcome" | "repaired";

export interface HeldInfo {
  reason: string;
  mode: HoldMode;
  decision?: "approve" | "reject";
  waitedMs?: number;
  cancelled?: boolean;
}

/** An A/B arm: control observes and records only; treatment is the boundary as shipped. */
export type Arm = "control" | "treatment";
/** How a daemon or wrap assigns arms: one arm for every session, a coin per session, or a hash of the UTC date, so every session of a day, on every server, lands in the same arm. */
export type ArmMode = Arm | "coinflip" | "daily";
export const ARM_MODES: readonly ArmMode[] = ["control", "treatment", "coinflip", "daily"];
export const isArmMode = (s: string): s is ArmMode => (ARM_MODES as readonly string[]).includes(s);

/**
 * The arm for a new session. `daily` hashes the UTC date so every session that day, on every
 * server, lands in the same arm (a day is the unit that joins the ledger to a transcript audit).
 */
export function pickArm(mode: ArmMode, now: Date = new Date()): Arm {
  if (mode === "control" || mode === "treatment") return mode;
  if (mode === "daily") {
    const day = now.toISOString().slice(0, 10);
    const byte = createHash("sha256").update(`sayagain-arm:${day}`).digest()[0] ?? 0;
    return byte % 2 === 0 ? "control" : "treatment";
  }
  return randomInt(2) === 0 ? "control" : "treatment";
}

export interface PendingCall {
  /** The A/B arm of the session that sent it; undefined outside an experiment. */
  arm?: Arm;
  /** The host session that sent it, when it has a stable identity. */
  session?: string;
  /** The registry name of the boundary handling it. */
  server?: string;
  id: JsonRpcId;
  receipt: string;
  tool: string;
  toolClass: ToolClass;
  argShape: string[];
  /** Hash of the arguments as they were (last) sent upstream. */
  argsHash: string;
  /** Hash of the arguments as the client sent them; the dedupe identity. */
  clientArgsHash: string;
  arguments: unknown;
  hasIntent: boolean;
  intent?: string;
  task?: string;
  idempotencyKey?: string;
  startedAt: number;
  requestBytes: number;
  /** The request line as it will be (or was) sent upstream; updated by repair. */
  rawLine: string;
  held?: HeldInfo;
  attempts: number;
  repairs: RepairChange[];
  /** Learned coercions applied before the call left: a change, but not an attempt at recovery. */
  preCoercions: RepairChange[];
  replayOf?: string;
  /** The last failure the boundary saw for this call, kept for the rows it writes while holding. */
  lastFailure?: Failure;
  /** Which budget the repair counted against: the client's task, or a time window (spec 3.3 fallback). */
  budget?: "task" | "window";
  /** This is the boundary's own read-back of another call's effect: that call's receipt. */
  verifies?: string;
  /** The outcome was unknown and the boundary read it back (spec 8.3): what it found. */
  verified?: "present" | "absent";
  /**
   * For a call held before it was sent: whether its effect was already in the world, read while
   * the operator decided. A verifier answer that matches it proves nothing about the call.
   */
  preImage?: Promise<EffectState>;
}

/** What a verifier found: the call's effect is in the world, is not, or it could not say. */
export type EffectState = "present" | "absent" | "inconclusive";

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
  /** A sentence the learning loop appends to an error whose signature it has seen fixed before; `applied` names interventions already used on this call. */
  learnedHint?: (tool: string, signature: string, applied: string[]) => string | undefined;
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

/** JSON with object keys sorted at every level, so equal arguments hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const hashArgs = (input: unknown): string =>
  createHash("sha1")
    .update(canonicalJson(input ?? null))
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
  const argsHash = hashArgs(params.arguments);
  const intent = typeof meta[META.intent] === "string" ? (meta[META.intent] as string) : undefined;
  const call: PendingCall = {
    id: msg.id,
    receipt: newReceipt(now),
    tool: typeof params.name === "string" ? params.name : "",
    toolClass,
    argShape: shapeOf(params.arguments),
    argsHash,
    clientArgsHash: argsHash,
    arguments: params.arguments,
    hasIntent: intent !== undefined,
    startedAt: now,
    requestBytes: bytes,
    rawLine,
    attempts: 1,
    repairs: [],
    preCoercions: [],
  };
  if (intent !== undefined) call.intent = intent;
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
    const message =
      typeof msg.error.message === "string" ? msg.error.message : signatureOf(msg.error.message);
    const code = typeof msg.error.code === "number" ? msg.error.code : undefined;
    const f: Failure = {
      errorClass: classifyError(message, code),
      signature: signatureOf(message),
      text: message,
    };
    if (code !== undefined) f.rpcCode = code;
    return f;
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
  const out: JsonRpcRequest = { ...msg, params };
  if (id !== undefined) out.id = id;
  return JSON.stringify(out);
}

const hintText = (
  opts: BoundaryOptions,
  tool: string,
  signature: string,
  applied: string[],
): string => {
  const hint = opts.learnedHint?.(tool, signature, applied);
  return hint ? ` ${hint}` : "";
};

const stampMeta = (result: Record<string, unknown>, entries: Record<string, unknown>): void => {
  result._meta = { ...((result._meta as Record<string, unknown> | undefined) ?? {}), ...entries };
};

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
  if (call.arm !== undefined) row.arm = call.arm;
  if (call.verifies !== undefined) row.verifies = call.verifies;
  if (call.verified !== undefined) row.verified = call.verified;
  if (call.session !== undefined) row.session = call.session;
  if (call.server !== undefined) row.server = call.server;
  if (call.held) row.held = { ...call.held };
  if (call.attempts > 1) row.attempts = call.attempts;
  const changed = [...call.preCoercions, ...call.repairs];
  if (changed.length) row.repairs = changed.map((c) => ({ path: c.path, rule: c.rule }));
  if (call.replayOf !== undefined) row.replayOf = call.replayOf;
  if (call.budget !== undefined) row.budget = call.budget;
  return row;
}

/** A ledger row for an attempt that failed while the boundary went on to hold the call. */
export function failedAttemptRow(
  call: PendingCall,
  upstream: string,
  failure: Failure,
  responseBytes: number,
  now: number,
): LedgerRow {
  const row = baseRow(call, upstream, "executed", responseBytes, now);
  row.isError = true;
  row.errorClass = failure.errorClass;
  row.errorSignature = failure.signature;
  if (failure.rpcCode !== undefined) row.errorCode = failure.rpcCode;
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
  /** Set when the boundary's own tools/list probe was answered without a tool list. */
  probed?: boolean;
  /** Set when a tools/call succeeded, so the caller can remember it for dedupe. */
  remember?: { call: PendingCall; result: unknown };
  /** The call this response completed, when it was a tools/call. */
  call?: PendingCall;
}

/**
 * Rewrite a server-to-client message. Only two shapes change: a tools/call
 * response gains receipt and status (in result._meta, or error.data when
 * the response is a JSON-RPC error) plus guidance on a failure; an
 * initialize response gains the boundary announcement. Everything else
 * passes through untouched.
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
    else if (own) out.probed = true;
    return out;
  }

  if (state.initializeIds.has(key)) {
    state.initializeIds.delete(key);
    if (msg.error || typeof msg.result !== "object" || msg.result === null)
      return { message: msg, changed: false };
    const result = { ...(msg.result as Record<string, unknown>) };
    const serverInfo = result.serverInfo as { name?: unknown } | undefined;
    if (serverInfo && typeof serverInfo.name === "string") state.upstreamName = serverInfo.name;
    const boundary: Record<string, unknown> = {
      name: BOUNDARY_NAME,
      version: opts.version,
      upstream: state.upstreamName,
      ledger: opts.ledgerKind,
      shim: opts.shim,
    };
    if (opts.hold !== undefined) boundary.hold = opts.hold;
    stampMeta(result, { [META.boundary]: boundary });
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
  const tried = call.attempts > 1 || call.repairs.length > 0 || call.held?.decision === "approve";
  const failure = failureOf(msg);
  const status: Status = failure
    ? tried && call.replayOf === undefined
      ? "dead-lettered"
      : "executed"
    : call.repairs.length || call.preCoercions.length
      ? "repaired"
      : "executed";
  const row = baseRow(call, state.upstreamName, status, bytes, now);
  const meta: Record<string, unknown> = { [META.receipt]: call.receipt, [META.status]: status };
  if (call.held)
    meta[META.held] = {
      reason: call.held.reason,
      mode: call.held.mode,
      decision: call.held.decision ?? null,
    };
  const allChanges = [...call.preCoercions, ...call.repairs];
  if (allChanges.length)
    meta[META.repair] = {
      kind: allChanges.every((c) => c.rule === "rename") ? "rename" : "coerce",
      changes: allChanges.map(({ via: _via, ...c }) => c),
    };
  if (call.replayOf !== undefined) meta[META.replayOf] = call.replayOf;

  if (msg.error) {
    row.isError = true;
    if (typeof msg.error.code === "number") row.errorCode = msg.error.code;
    if (failure) {
      row.errorSignature = failure.signature;
      row.errorClass = failure.errorClass;
    }
    // A JSON-RPC error has no result; the receipt rides in error.data when that is free or an object.
    const data = msg.error.data;
    if (data === undefined || (typeof data === "object" && data !== null && !Array.isArray(data))) {
      const error = {
        ...msg.error,
        data: { ...((data as Record<string, unknown> | undefined) ?? {}), ...meta },
      };
      const message: JsonRpcResponse = { ...msg, error };
      return own
        ? { message, changed: true, row, call, swallow: true }
        : { message, changed: true, row, call };
    }
    return own
      ? { message: msg, changed: false, row, call, swallow: true }
      : { message: msg, changed: false, row, call };
  }

  if (typeof msg.result !== "object" || msg.result === null)
    return own
      ? { message: msg, changed: false, row, call, swallow: true }
      : { message: msg, changed: false, row, call };
  const result = { ...(msg.result as Record<string, unknown>) };
  if (failure) {
    row.isError = true;
    row.errorSignature = failure.signature;
    row.errorClass = failure.errorClass;
    if (opts.rewriteErrors ?? true) {
      const content = Array.isArray(result.content) ? [...result.content] : [];
      content.push({
        type: "text",
        text:
          guidanceFor({
            errorClass: failure.errorClass,
            attempts: call.attempts,
            repaired: call.repairs.length > 0,
            receipt: call.receipt,
            status: status === "dead-lettered" ? "dead-lettered" : "executed",
            tool: call.tool,
          }) +
          hintText(
            opts,
            call.tool,
            failure.signature,
            call.preCoercions.map((c) => c.via ?? ""),
          ),
      });
      result.content = content;
    }
  }
  stampMeta(result, meta);
  const message = { ...msg, result };
  const out: Rewrite = { message, changed: true, row, call };
  if (own) out.swallow = true;
  if (!row.isError) out.remember = { call, result };
  return out;
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
  stampMeta(result, {
    [META.receipt]: call.receipt,
    [META.status]: "deduplicated",
    [META.duplicateOf]: firstReceipt,
  });
  return { jsonrpc: "2.0", id: call.id, result };
}

export interface HeldResponseOptions {
  rejected: boolean;
  mode: HoldMode;
  /** For unknown-outcome and repaired holds: what the failed attempt said. */
  failure?: Failure;
  repairs?: RepairChange[];
}

/** The response for a call that is still held after the wait, or was rejected. */
export function heldResponse(
  call: PendingCall,
  reason: string,
  expiresAt: number,
  opts: HeldResponseOptions,
): JsonRpcMessage {
  const expires = new Date(expiresAt).toISOString();
  const approve = `sayagain approve ${call.receipt}`;
  let text: string;
  if (opts.mode === "unknown-outcome") {
    const said = opts.failure ? ` The attempt failed with: ${opts.failure.signature}.` : "";
    text = opts.rejected
      ? `UNABLE: this call was sent to the server, its outcome is unknown, and an operator declined to re-send it.${said} Receipt ${call.receipt}. Do not repeat the call; tell the user to verify the result.`
      : `STANDBY: this call was sent to the server and its outcome is unknown.${said} It has NOT been re-sent, because the tool may have already applied it. Receipt ${call.receipt}. Do not repeat the call yourself; an operator can verify and re-send it (${approve}) until ${expires}. Continue with other work or tell the user.`;
  } else if (opts.mode === "repaired") {
    const changes = (opts.repairs ?? []).map((c) => `${c.path} ${c.rule}`).join(", ");
    text = opts.rejected
      ? `UNABLE: the server rejected the arguments and an operator declined the corrected version (${changes}). Receipt ${call.receipt}. Check the tool's schema before calling again.`
      : `STANDBY: the server rejected the arguments. Say Again prepared a corrected version (${changes}) that needs operator approval before it is sent (${approve}, until ${expires}). Receipt ${call.receipt}. Nothing has been executed. Continue with other work or tell the user.`;
  } else {
    text = opts.rejected
      ? `UNABLE: an operator rejected this call. Receipt ${call.receipt}. Do not retry it; tell the user.`
      : `STANDBY: this call is held for approval and has not been executed. Receipt ${call.receipt}. Reason: ${reason}. It expires at ${expires} unless an operator approves it (${approve}). Continue with other work or tell the user.`;
  }
  const held: Record<string, unknown> = { reason, mode: opts.mode, expiresAt: expires };
  if (opts.rejected) held.decision = "reject";
  if (opts.failure) held.attemptError = opts.failure.signature;
  return {
    jsonrpc: "2.0",
    id: call.id,
    result: {
      content: [{ type: "text", text }],
      isError: opts.rejected,
      _meta: { [META.receipt]: call.receipt, [META.status]: "held", [META.held]: held },
    },
  };
}

/** The response for a call the boundary could not complete: the upstream went away or never answered. */
export function abandonedResponse(call: PendingCall, reason: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: call.id,
    error: {
      code: -32000,
      message: `Say Again: ${reason}. Receipt ${call.receipt}; the call is dead-lettered for an operator to replay.`,
      data: { [META.receipt]: call.receipt, [META.status]: "dead-lettered" },
    },
  };
}

/**
 * The verifier's arguments from its declaration and the original call: a literal stays as it is and
 * `$arguments.<name>` takes the original's value. Null when a reference names nothing the call sent,
 * so the boundary verifies nothing rather than something else.
 */
export function resolveVerifyArguments(
  decl: VerifyDeclaration,
  original: unknown,
): Record<string, unknown> | null {
  const source =
    typeof original === "object" && original !== null && !Array.isArray(original)
      ? (original as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  let references = 0;
  for (const [key, template] of Object.entries(decl.arguments ?? {})) {
    const ref = /^\$arguments\.([A-Za-z0-9_-]+)$/.exec(template);
    if (!ref) {
      // Any other reference ($result.x, a typo) is a declaration the boundary cannot honour. A
      // literal it passes through; a verifier is a read on the same server and can take one.
      if (template.startsWith("$")) return null;
      out[key] = template;
      continue;
    }
    const name = ref[1] as string;
    if (!Object.hasOwn(source, name)) return null;
    out[key] = source[name];
    references++;
  }
  // A read that names nothing from the call reads something else, and would call every write present.
  return references ? out : null;
}

/** The answer for a write whose outcome was unknown until the boundary read it back and found it. */
export function verifiedResponse(
  call: PendingCall,
  decl: VerifyDeclaration,
  text: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: call.id,
    result: {
      content: [
        {
          type: "text",
          text: `${call.tool} was applied: the server timed out after the request was sent, and ${decl.tool} confirms the effect is present. Do not repeat it.${text ? ` (${text.slice(0, 200)})` : ""}`,
        },
      ],
      _meta: {
        [META.receipt]: call.receipt,
        [META.status]: "executed",
        [META.verified]: { tool: decl.tool, effect: decl.effect ?? "result" },
      },
    },
  };
}

/** The control arm's answer to a call the upstream never answered: the reason, nothing more. */
export function unansweredResponse(call: PendingCall, reason: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: call.id,
    error: {
      code: -32000,
      message: reason,
      data: { [META.receipt]: call.receipt, [META.status]: "executed" },
    },
  };
}
