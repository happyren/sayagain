/**
 * `sayagain wrap`: the boundary in-process around one stdio MCP server.
 * Bytes pass through unchanged except for the rewrites in boundary.ts, the
 * DISREGARD short-circuit for duplicates, STANDBY holds, bounded retry,
 * deterministic repair and dead-lettering.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Server } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  type BoundaryOptions,
  baseRow,
  createState,
  describeCall,
  duplicateResponse,
  type Failure,
  failureOf,
  hashArgs,
  heldResponse,
  keyOf,
  observeClientMessage,
  ownId,
  ownToolsListRequest,
  type PendingCall,
  pendingFor,
  registerPending,
  rewriteServerMessage,
  shapeOf,
  withArguments,
} from "./boundary.js";
import { type DeadLetterSummary, type ReplayOutcome, startControlServer } from "./control.js";
import { type DeadLetter, DeadLetterStore } from "./deadletter.js";
import { DedupeCache } from "./dedupe.js";
import { HoldQueue } from "./holds.js";
import { isRequest, type JsonRpcRequest, LineSplitter, parseMessage } from "./jsonrpc.js";
import { JsonlLedger, type Ledger } from "./ledger.js";
import { DEFAULT_POLICY, type PolicyOptions, shouldHold, ToolClassifier } from "./policy.js";
import { repairArguments } from "./repair.js";
import { resultText } from "./signature.js";
import { PROXY_VERSION } from "./version.js";

export interface WrapOptions {
  command: string;
  args?: string[];
  /** Defaults to process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
  ledger?: Ledger;
  ledgerKind?: BoundaryOptions["ledgerKind"];
  /** Dead-letter file; omit for memory only. */
  deadLetterPath?: string;
  upstreamName?: string;
  announce?: boolean;
  env?: NodeJS.ProcessEnv;
  policy?: Partial<PolicyOptions>;
  /** Start the control socket so the CLI can reach this process. Default true. */
  control?: boolean;
  /** Hold time to live once the wait has elapsed. */
  holdTtlMs?: number;
  /** How long a tools/call may wait for the classifier to learn annotations. */
  warmupMs?: number;
}

export interface Wrapped {
  child: ChildProcess;
  holds: HoldQueue;
  classifier: ToolClassifier;
  deadLetters: DeadLetterStore;
  /** Re-send a dead-lettered call, optionally with new arguments. The result reaches the ledger and the caller, not the model. */
  replay: (receipt: string, args?: unknown) => Promise<ReplayOutcome | null>;
  /** Resolves with the child's exit code once it has exited and output is flushed. */
  done: Promise<number>;
}

type FailureAction = "retry" | "repair" | "hold" | "final";

export function wrap(options: WrapOptions): Wrapped {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ledger = options.ledger ?? new JsonlLedger();
  const policy: PolicyOptions = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const state = createState(options.upstreamName ?? "upstream");
  const classifier = new ToolClassifier(policy.classes);
  const dedupe = new DedupeCache(policy.dedupeWindowMs);
  const holds = new HoldQueue();
  const deadLetters = new DeadLetterStore(options.deadLetterPath);
  const repairBudget = new Map<string, number>();
  const replayWaiters = new Map<string, (o: ReplayOutcome) => void>();
  const holdTtlMs = options.holdTtlMs ?? 3_600_000;
  const warmupMs = options.warmupMs ?? 2000;
  const boundary: BoundaryOptions = {
    version: PROXY_VERSION,
    ledgerKind: options.ledgerKind ?? (ledger instanceof JsonlLedger ? "jsonl" : "memory"),
    announce: options.announce ?? true,
    shim: false,
    hold: policy.hold,
    rewriteErrors: policy.rewriteErrors,
  };

  const child = spawn(options.command, options.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  const toChild = child.stdin;
  const fromChild = child.stdout;
  if (!toChild || !fromChild) throw new Error("child process has no stdio pipes");

  const respond = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  const warmClassifier = () => toChild.write(`${JSON.stringify(ownToolsListRequest(state))}\n`);
  const untilWarm = () =>
    classifier.warm
      ? Promise.resolve()
      : Promise.race([classifier.ready, new Promise<void>((r) => setTimeout(r, warmupMs))]);
  const budgetKey = (call: PendingCall) => call.task ?? "connection";

  const deadLetterSummaries = (): DeadLetterSummary[] =>
    deadLetters.list().map((d) => {
      const s: DeadLetterSummary = {
        receipt: d.receipt,
        ts: d.ts,
        upstream: d.upstream,
        tool: d.tool,
        errorClass: d.errorClass,
        errorSignature: d.errorSignature,
        attempts: d.attempts,
        repairs: d.repairs,
        pid: process.pid,
      };
      if (d.intent !== undefined) s.intent = d.intent;
      return s;
    });

  const replay = (receipt: string, args?: unknown): Promise<ReplayOutcome | null> => {
    const entry = deadLetters.get(receipt);
    if (!entry) return Promise.resolve(null);
    const original = JSON.parse(entry.rawLine) as JsonRpcRequest;
    const useArgs = args ?? original.params?.arguments;
    const id = ownId(state, "replay");
    const rawLine = `${withArguments(entry.rawLine, useArgs, id)}\n`;
    const req = JSON.parse(rawLine) as JsonRpcRequest;
    const call = describeCall(
      req,
      rawLine,
      classifier.classOf(entry.tool),
      Buffer.byteLength(rawLine),
    );
    call.replayOf = receipt;
    registerPending(state, call);
    return new Promise((resolve) => {
      replayWaiters.set(keyOf(id), resolve);
      toChild.write(rawLine);
    });
  };

  let control: Server | undefined;
  if (options.control ?? true)
    control = startControlServer(holds, undefined, { deadletters: deadLetterSummaries, replay });

  const holdThenMaybeSend = async (call: PendingCall, reason: string, onApprove: () => void) => {
    const createdAt = Date.now();
    const expiresAt = createdAt + policy.holdWaitMs + holdTtlMs;
    const hold: Parameters<typeof holds.create>[0] = {
      receipt: call.receipt,
      tool: call.tool,
      toolClass: call.toolClass,
      reason,
      arguments: call.arguments,
      createdAt,
      expiresAt,
    };
    if (call.intent !== undefined) hold.intent = call.intent;
    holds.create(hold);
    call.held = { reason };
    const decision = await holds.waitFor(call.receipt, policy.holdWaitMs);
    call.held.waitedMs = Date.now() - createdAt;
    if (decision === "approve") {
      call.held.decision = "approve";
      holds.forget(call.receipt);
      onApprove();
      registerPending(state, call);
      toChild.write(call.rawLine);
      return;
    }
    if (decision === "reject") {
      call.held.decision = "reject";
      holds.forget(call.receipt);
      ledger.append(baseRow(call, state.upstreamName, "held", 0, Date.now()));
      respond(heldResponse(call, reason, expiresAt, true));
      return;
    }
    // Still held after the wait: tell the agent, keep the hold open for a later decision.
    ledger.append(baseRow(call, state.upstreamName, "held", 0, Date.now()));
    respond(heldResponse(call, reason, expiresAt, false));
    const later = await holds.waitFor(call.receipt, holdTtlMs);
    holds.forget(call.receipt);
    if (later === "approve") {
      // Executed after the agent moved on: the result reaches the ledger, not the model.
      call.held.decision = "approve";
      onApprove();
      state.ownIds.add(keyOf(call.id));
      registerPending(state, call);
      toChild.write(call.rawLine);
    }
  };

  const handleToolCall = async (line: string, text: string) => {
    const msg = parseMessage(line);
    if (!msg || Array.isArray(msg) || !isRequest(msg)) {
      toChild.write(text);
      return;
    }
    const tool = typeof msg.params?.name === "string" ? msg.params.name : "";
    await untilWarm();
    const call = describeCall(msg, text, classifier.classOf(tool), Buffer.byteLength(text));

    // DISREGARD: idempotency key always; fingerprint only for calls that can change the world.
    const keys: string[] = [];
    if (call.idempotencyKey !== undefined)
      keys.push(DedupeCache.keyFor(call.tool, call.idempotencyKey));
    if (call.toolClass !== "read-only")
      keys.push(DedupeCache.fingerprintFor(call.tool, call.argsHash));
    for (const k of keys) {
      const hit = dedupe.lookup(k);
      if (!hit) continue;
      const row = baseRow(call, state.upstreamName, "deduplicated", 0, Date.now());
      row.duplicateOf = hit.receipt;
      ledger.append(row);
      respond(duplicateResponse(call, hit.receipt, hit.result));
      return;
    }

    // STANDBY: hold before leaving.
    if (shouldHold(call.toolClass, policy.hold)) {
      const reason =
        policy.hold === "always"
          ? "policy holds every call that can change the world"
          : "tool is classified destructive";
      await holdThenMaybeSend(call, reason, () => {});
      return;
    }

    registerPending(state, call);
    toChild.write(text);
  };

  const decideOnFailure = (call: PendingCall, failure: Failure): FailureAction => {
    if (call.replayOf !== undefined) return "final";
    if (failure.errorClass === "retryable") {
      const safe = call.toolClass === "read-only" || call.toolClass === "idempotent-write";
      if (safe) return call.attempts < policy.retryAttempts ? "retry" : "final";
      return call.held ? "final" : "hold";
    }
    if (failure.errorClass === "coercible" && policy.repair && call.repairs.length === 0) {
      const used = repairBudget.get(budgetKey(call)) ?? 0;
      if (used < policy.repairsPerTask && classifier.schemaOf(call.tool) !== undefined)
        return "repair";
    }
    return "final";
  };

  const clientLines = new LineSplitter();
  input.on("data", (chunk: Buffer | string) => {
    for (const line of clientLines.push(chunk)) {
      const text = `${line}\n`;
      const msg = parseMessage(line);
      const kind = msg && !Array.isArray(msg) ? observeClientMessage(msg, state) : null;
      if (kind === "tools/call") {
        void handleToolCall(line, text);
        continue;
      }
      toChild.write(text);
      // The server may serve requests once the client says it is initialized: learn the tools now.
      if (
        msg &&
        !Array.isArray(msg) &&
        "method" in msg &&
        msg.method === "notifications/initialized"
      )
        warmClassifier();
    }
  });
  input.on("end", () => {
    const rest = clientLines.flush();
    if (rest) toChild.write(rest);
    toChild.end();
  });

  const serverLines = new LineSplitter();
  fromChild.on("data", (chunk: Buffer) => {
    for (const line of serverLines.push(chunk)) {
      const msg = parseMessage(line);
      if (!msg || Array.isArray(msg)) {
        output.write(`${line}\n`);
        continue;
      }
      const bytes = Buffer.byteLength(line) + 1;
      if ("method" in msg && msg.method === "notifications/tools/list_changed") warmClassifier();

      // Before finishing a failed call, decide whether the boundary tries something first.
      const pending = pendingFor(msg, state);
      const failure = pending ? failureOf(msg) : null;
      if (pending && failure) {
        const action = decideOnFailure(pending, failure);
        if (action === "retry") {
          const delay = policy.retryBaseMs * 2 ** (pending.attempts - 1);
          pending.attempts++;
          setTimeout(() => toChild.write(pending.rawLine), delay);
          continue;
        }
        if (action === "repair") {
          const repaired = repairArguments(pending.arguments, classifier.schemaOf(pending.tool));
          if (repaired) {
            pending.repairs = repaired.changes;
            pending.arguments = repaired.arguments;
            pending.argShape = shapeOf(repaired.arguments);
            pending.argsHash = hashArgs(repaired.arguments);
            pending.rawLine = `${withArguments(pending.rawLine, repaired.arguments)}\n`;
            pending.attempts++;
            repairBudget.set(budgetKey(pending), (repairBudget.get(budgetKey(pending)) ?? 0) + 1);
            toChild.write(pending.rawLine);
            continue;
          }
        }
        if (action === "hold") {
          state.pending.delete(keyOf(pending.id));
          void holdThenMaybeSend(
            pending,
            `write failed with unknown outcome: ${failure.signature}`,
            () => {
              pending.attempts++;
            },
          );
          continue;
        }
      }

      const { message, changed, swallow, row, tools, remember, call } = rewriteServerMessage(
        msg,
        state,
        boundary,
        bytes,
      );
      if (tools !== undefined) classifier.learn(tools);
      if (row) ledger.append(row);
      if (row && call && row.status === "dead-lettered") {
        const entry: DeadLetter = {
          receipt: call.receipt,
          ts: row.ts,
          upstream: row.upstream,
          tool: call.tool,
          rawLine: call.rawLine,
          errorClass: row.errorClass ?? "other",
          errorSignature: row.errorSignature ?? "",
          attempts: call.attempts,
          repairs: call.repairs.length,
        };
        if (call.intent !== undefined) entry.intent = call.intent;
        if (call.task !== undefined) entry.task = call.task;
        deadLetters.add(entry);
      }
      if (remember) {
        const { call: done, result } = remember;
        if (done.idempotencyKey !== undefined)
          dedupe.remember(DedupeCache.keyFor(done.tool, done.idempotencyKey), done.receipt, result);
        if (done.toolClass !== "read-only")
          dedupe.remember(
            DedupeCache.fingerprintFor(done.tool, done.argsHash),
            done.receipt,
            result,
          );
      }
      if (call && "id" in message && message.id !== undefined && message.id !== null) {
        const waiter = replayWaiters.get(keyOf(message.id));
        if (waiter) {
          replayWaiters.delete(keyOf(message.id));
          const result = "result" in message ? message.result : undefined;
          const text =
            "error" in message && message.error
              ? message.error.message
              : resultText(result).slice(0, 500);
          waiter({
            receipt: call.receipt,
            replayOf: call.replayOf ?? "",
            isError: row?.isError ?? true,
            text,
          });
        }
      }
      if (swallow) continue;
      output.write(changed ? `${JSON.stringify(message)}\n` : `${line}\n`);
    }
  });

  const done = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      const rest = serverLines.flush();
      if (rest) output.write(rest);
      control?.close();
      resolve(code ?? 0);
    });
  });

  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  return { child, holds, classifier, deadLetters, replay, done };
}
