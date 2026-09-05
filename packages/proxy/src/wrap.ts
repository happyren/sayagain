/**
 * `sayagain wrap`: the boundary in-process around one stdio MCP server.
 * Bytes pass through unchanged except for the rewrites in boundary.ts, the
 * DISREGARD short-circuit for duplicates, STANDBY holds, bounded retry,
 * deterministic repair and dead-lettering. Client lines are processed in
 * order; a call parks in a hold without blocking the lines behind it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Server } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  abandonedResponse,
  type BoundaryOptions,
  baseRow,
  createState,
  describeCall,
  duplicateResponse,
  type Failure,
  failedAttemptRow,
  failureOf,
  type HoldMode,
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
import {
  type DeadLetterSummary,
  type ReplayOutcome,
  startControlServer,
  summarizeDeadLetter,
} from "./control.js";
import { type DeadLetter, DeadLetterStore } from "./deadletter.js";
import { DedupeCache, type Remembered } from "./dedupe.js";
import { HoldQueue } from "./holds.js";
import {
  isRequest,
  type JsonRpcId,
  type JsonRpcRequest,
  LineSplitter,
  parseMessage,
} from "./jsonrpc.js";
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
  /** A forwarded call with no answer for this long is abandoned and dead-lettered. */
  pendingTtlMs?: number;
  /** How long a replay waits for the upstream. */
  replayTimeoutMs?: number;
  /** Where diagnostics go. Default process.stderr. */
  log?: (line: string) => void;
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
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ledger = options.ledger ?? new JsonlLedger();
  const policy: PolicyOptions = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const state = createState(options.upstreamName ?? "upstream");
  const classifier = new ToolClassifier(policy.classes);
  const dedupe = new DedupeCache(policy.dedupeWindowMs);
  const holds = new HoldQueue();
  const deadLetters = new DeadLetterStore(options.deadLetterPath);
  const repairBudget = new Map<string, number>();
  const replayWaiters = new Map<
    string,
    { resolve: (o: ReplayOutcome) => void; timer: NodeJS.Timeout }
  >();
  const settles = new Map<string, (r: Remembered | null) => void>();
  const heldById = new Map<string, PendingCall>();
  const holdTtlMs = options.holdTtlMs ?? 3_600_000;
  const warmupMs = options.warmupMs ?? 5000;
  const pendingTtlMs = options.pendingTtlMs ?? 600_000;
  const replayTimeoutMs = options.replayTimeoutMs ?? 30_000;
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

  let stdinEnded = false;
  let childGone = false;
  let finished = false;
  let exitCode: number | null = null;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const respond = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  const upstreamReady = () => !childGone && !stdinEnded && toChild.writable;
  const sendUpstream = (line: string): boolean => {
    if (!upstreamReady()) return false;
    toChild.write(line);
    return true;
  };
  const warmClassifier = () => {
    sendUpstream(`${JSON.stringify(ownToolsListRequest(state))}\n`);
  };
  const untilWarm = () =>
    classifier.warm
      ? Promise.resolve()
      : Promise.race([classifier.ready, new Promise<void>((r) => setTimeout(r, warmupMs).unref())]);
  const budgetKey = (call: PendingCall, now: number) => {
    if (call.task !== undefined) {
      call.budget = "task";
      return `task:${call.task}`;
    }
    call.budget = "window";
    return `window:${Math.floor(now / policy.repairWindowMs)}`;
  };
  const settle = (call: PendingCall, r: Remembered | null) => {
    const s = settles.get(call.receipt);
    if (s) {
      settles.delete(call.receipt);
      s(r);
    }
  };

  /** The boundary gives up on a forwarded call: answer the client with an error, dead-letter it. */
  const abandon = (call: PendingCall, reason: string) => {
    state.pending.delete(keyOf(call.id));
    const failure: Failure = { errorClass: "retryable", signature: reason, text: reason };
    const row = failedAttemptRow(call, state.upstreamName, failure, 0, Date.now());
    row.status = "dead-lettered";
    ledger.append(row);
    recordDeadLetter(call, row.errorClass ?? "retryable", reason);
    settle(call, null);
    if (!state.ownIds.delete(keyOf(call.id))) respond(abandonedResponse(call, reason));
    const waiter = replayWaiters.get(keyOf(call.id));
    if (waiter) {
      clearTimeout(waiter.timer);
      replayWaiters.delete(keyOf(call.id));
      waiter.resolve({
        receipt: call.receipt,
        replayOf: call.replayOf ?? "",
        isError: true,
        text: reason,
      });
    }
  };

  const recordDeadLetter = (call: PendingCall, errorClass: string, errorSignature: string) => {
    const entry: DeadLetter = {
      receipt: call.receipt,
      ts: new Date(call.startedAt).toISOString(),
      upstream: state.upstreamName,
      tool: call.tool,
      rawLine: call.rawLine,
      errorClass,
      errorSignature,
      attempts: call.attempts,
      repairs: call.repairs.length,
    };
    if (call.intent !== undefined) entry.intent = call.intent;
    if (call.task !== undefined) entry.task = call.task;
    deadLetters.add(entry);
  };

  const forward = (call: PendingCall) => {
    registerPending(state, call);
    if (!sendUpstream(call.rawLine)) abandon(call, "upstream is not accepting requests");
  };

  /** Park a call in a hold. Returns as soon as the hold exists; the decision is handled asynchronously. */
  const park = (call: PendingCall, reason: string, mode: HoldMode) => {
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
    call.held = { reason, mode };
    heldById.set(keyOf(call.id), call);
    const finishHold = () => {
      holds.forget(call.receipt);
      heldById.delete(keyOf(call.id));
    };
    const heldRow = (now: number) => {
      const row = baseRow(call, state.upstreamName, "held", 0, now);
      if (call.lastFailure) {
        row.errorClass = call.lastFailure.errorClass;
        row.errorSignature = call.lastFailure.signature;
      }
      return row;
    };
    const answerHeld = (rejected: boolean) => {
      if (call.held?.cancelled) return;
      const opts: Parameters<typeof heldResponse>[3] = { rejected, mode };
      if (call.lastFailure) opts.failure = call.lastFailure;
      if (call.repairs.length) opts.repairs = call.repairs;
      respond(heldResponse(call, reason, expiresAt, opts));
    };
    const send = (afterWait: boolean) => {
      if (call.held) call.held.decision = "approve";
      if (mode !== "pre") call.attempts++;
      if (afterWait) state.ownIds.add(keyOf(call.id));
      forward(call);
    };
    void (async () => {
      const decision = await holds.waitFor(call.receipt, policy.holdWaitMs);
      if (call.held) call.held.waitedMs = Date.now() - createdAt;
      if (decision === "approve") {
        finishHold();
        send(false);
        return;
      }
      if (decision === "reject") {
        if (call.held) call.held.decision = "reject";
        finishHold();
        ledger.append(heldRow(Date.now()));
        answerHeld(true);
        settle(call, null);
        return;
      }
      ledger.append(heldRow(Date.now()));
      answerHeld(false);
      settle(call, null);
      const later = await holds.waitFor(call.receipt, holdTtlMs);
      finishHold();
      if (later === "approve") send(true);
      else if (later === "reject" && call.held) {
        call.held.decision = "reject";
        ledger.append(heldRow(Date.now()));
      }
    })().catch((err: unknown) =>
      log(
        `sayagain: hold ${call.receipt} failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  };

  /** A client cancellation for a held call: drop the hold, answer nothing, tell the upstream nothing. */
  const cancelHeld = (id: JsonRpcId | undefined): boolean => {
    if (id === undefined) return false;
    const call = heldById.get(keyOf(id));
    if (!call?.held) return false;
    call.held.cancelled = true;
    holds.decide(call.receipt, "reject");
    return true;
  };

  const answerDuplicate = (call: PendingCall, first: Remembered) => {
    const row = baseRow(call, state.upstreamName, "deduplicated", 0, Date.now());
    row.duplicateOf = first.receipt;
    ledger.append(row);
    respond(duplicateResponse(call, first.receipt, first.result));
  };

  const handleToolCall = async (msg: JsonRpcRequest, text: string) => {
    const tool = typeof msg.params?.name === "string" ? msg.params.name : "";
    await untilWarm();
    if (!classifier.warm) warmClassifier();
    const call = describeCall(msg, text, classifier.classOf(tool), Buffer.byteLength(text));

    // DISREGARD: one identity per call; a concurrent duplicate waits for the first result.
    const key = DedupeCache.keyFor(call);
    if (key !== null) {
      const hit = dedupe.lookup(key);
      if (hit) {
        answerDuplicate(call, hit);
        return;
      }
      const reservation = dedupe.reserve(key);
      if ("existing" in reservation) {
        const first = await reservation.existing;
        if (first) {
          answerDuplicate(call, first);
          return;
        }
        const again = dedupe.reserve(key);
        if ("settle" in again) settles.set(call.receipt, again.settle);
      } else {
        settles.set(call.receipt, reservation.settle);
      }
    }

    // STANDBY: hold before leaving.
    if (shouldHold(call.toolClass, policy.hold)) {
      const reason =
        policy.hold === "always"
          ? "policy holds every call that can change the world"
          : "tool is classified destructive";
      park(call, reason, "pre");
      return;
    }
    forward(call);
  };

  const decideOnFailure = (call: PendingCall, failure: Failure, now: number): FailureAction => {
    if (call.replayOf !== undefined) return "final";
    if (failure.errorClass === "retryable") {
      const safe = call.toolClass === "read-only" || call.toolClass === "idempotent-write";
      if (safe) return call.attempts < policy.retryAttempts ? "retry" : "final";
      return policy.hold === "never" || call.held ? "final" : "hold";
    }
    if (failure.errorClass === "coercible" && policy.repair && call.repairs.length === 0) {
      const used = repairBudget.get(budgetKey(call, now)) ?? 0;
      if (used < policy.repairsPerTask && classifier.schemaOf(call.tool) !== undefined)
        return "repair";
    }
    return "final";
  };

  /** Try to recover a failed call. Returns true when the response was consumed and must not be forwarded. */
  const recover = (call: PendingCall, failure: Failure, bytes: number): boolean => {
    const now = Date.now();
    const action = decideOnFailure(call, failure, now);
    if (action === "retry") {
      call.attempts++;
      const delay = policy.retryBaseMs * 2 ** (call.attempts - 2);
      setTimeout(() => {
        if (!sendUpstream(call.rawLine)) abandon(call, "upstream is not accepting requests");
      }, delay);
      return true;
    }
    if (action === "repair") {
      const repaired = repairArguments(call.arguments, classifier.schemaOf(call.tool));
      if (!repaired) return false;
      call.repairs = repaired.changes;
      call.arguments = repaired.arguments;
      call.argShape = shapeOf(repaired.arguments);
      call.argsHash = hashArgs(repaired.arguments);
      call.rawLine = `${withArguments(call.rawLine, repaired.arguments)}\n`;
      const k = budgetKey(call, now);
      repairBudget.set(k, (repairBudget.get(k) ?? 0) + 1);
      const safe = call.toolClass === "read-only" || call.toolClass === "idempotent-write";
      if (safe || policy.hold === "never") {
        call.attempts++;
        if (!sendUpstream(call.rawLine)) abandon(call, "upstream is not accepting requests");
        return true;
      }
      // A write's arguments never change without a person seeing the change.
      state.pending.delete(keyOf(call.id));
      call.lastFailure = failure;
      ledger.append(failedAttemptRow(call, state.upstreamName, failure, bytes, now));
      park(
        call,
        `arguments repaired (${repaired.changes.map((c) => `${c.path} ${c.rule}`).join(", ")}); approve to send`,
        "repaired",
      );
      return true;
    }
    if (action === "hold") {
      state.pending.delete(keyOf(call.id));
      call.lastFailure = failure;
      ledger.append(failedAttemptRow(call, state.upstreamName, failure, bytes, now));
      park(call, `write failed with unknown outcome: ${failure.signature}`, "unknown-outcome");
      return true;
    }
    return false;
  };

  const replay = (receipt: string, args?: unknown): Promise<ReplayOutcome | null> => {
    const entry = deadLetters.get(receipt);
    if (!entry) return Promise.resolve(null);
    const original = JSON.parse(entry.rawLine) as JsonRpcRequest;
    const id = ownId(state, "replay");
    const rawLine = `${withArguments(entry.rawLine, args ?? original.params?.arguments, id)}\n`;
    const req = JSON.parse(rawLine) as JsonRpcRequest;
    const call = describeCall(
      req,
      rawLine,
      classifier.classOf(entry.tool),
      Buffer.byteLength(rawLine),
    );
    call.replayOf = receipt;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (replayWaiters.delete(keyOf(id)))
          abandon(call, `no response from upstream within ${replayTimeoutMs} ms`);
      }, replayTimeoutMs);
      timer.unref();
      replayWaiters.set(keyOf(id), { resolve, timer });
      forward(call);
    });
  };

  let control: Server | undefined;
  if (options.control ?? true) {
    control = startControlServer(holds, undefined, {
      deadletters: (): DeadLetterSummary[] =>
        deadLetters.list().map((d) => summarizeDeadLetter(d, process.pid)),
      replay,
    });
  }

  // ---- client -> upstream, strictly in order; a hold parks a call without blocking the lines behind it.
  const handleClientLine = async (line: string) => {
    const text = `${line}\n`;
    const msg = parseMessage(line);
    if (!msg) {
      sendUpstream(text);
      return;
    }
    if (Array.isArray(msg)) {
      if (msg.some((m) => isRequest(m) && m.method === "tools/call"))
        log(
          "sayagain: JSON-RPC batch with tools/call passed through unobserved (batching was removed from MCP; disable it in the client)",
        );
      sendUpstream(text);
      return;
    }
    if ("method" in msg && msg.method === "notifications/cancelled") {
      const rid = (msg.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (cancelHeld(rid)) return;
      sendUpstream(text);
      return;
    }
    const kind = observeClientMessage(msg, state);
    if (kind === "tools/call" && isRequest(msg)) {
      await handleToolCall(msg, text);
      return;
    }
    sendUpstream(text);
    if ("method" in msg && msg.method === "notifications/initialized") warmClassifier();
  };

  let chain: Promise<void> = Promise.resolve();
  const clientLines = new LineSplitter();
  input.on("data", (chunk: Buffer | string) => {
    for (const line of clientLines.push(chunk)) {
      chain = chain
        .then(() => handleClientLine(line))
        .catch((err: unknown) => {
          log(
            `sayagain: failed to handle a client line: ${err instanceof Error ? err.message : String(err)}`,
          );
          const msg = parseMessage(line);
          if (msg && !Array.isArray(msg) && isRequest(msg))
            respond({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32603,
                message: `Say Again: internal error while handling the request: ${err instanceof Error ? err.message : String(err)}`,
              },
            });
        });
    }
  });
  input.on("end", () => {
    chain = chain.then(() => {
      const rest = clientLines.flush();
      if (rest && upstreamReady()) toChild.write(rest);
      stdinEnded = true;
      if (!childGone) toChild.end();
    });
  });

  // ---- upstream -> client
  const serverLines = new LineSplitter();
  const handleServerLine = (line: string) => {
    const msg = parseMessage(line);
    if (!msg || Array.isArray(msg)) {
      output.write(`${line}\n`);
      return;
    }
    const bytes = Buffer.byteLength(line) + 1;
    if ("method" in msg && msg.method === "notifications/tools/list_changed") warmClassifier();

    const pending = pendingFor(msg, state);
    const failure = pending ? failureOf(msg) : null;
    if (pending && failure && recover(pending, failure, bytes)) return;

    const { message, changed, swallow, row, tools, probed, remember, call } = rewriteServerMessage(
      msg,
      state,
      boundary,
      bytes,
    );
    if (tools !== undefined) classifier.learn(tools);
    else if (probed) classifier.markProbed();
    if (row) ledger.append(row);
    if (row && call && row.status === "dead-lettered")
      recordDeadLetter(call, row.errorClass ?? "other", row.errorSignature ?? "");
    if (call) {
      if (remember) {
        const key = DedupeCache.keyFor(call);
        const remembered: Remembered = {
          receipt: call.receipt,
          result: remember.result,
          at: Date.now(),
        };
        if (key !== null)
          dedupe.remember(key, remembered.receipt, remembered.result, remembered.at);
        settle(call, remembered);
      } else settle(call, null);
      const waiter = replayWaiters.get(keyOf(call.id));
      if (waiter) {
        clearTimeout(waiter.timer);
        replayWaiters.delete(keyOf(call.id));
        const result = "result" in message ? message.result : undefined;
        const text =
          "error" in message && message.error
            ? String(message.error.message)
            : resultText(result).slice(0, 500);
        const isError = row?.isError ?? true;
        if (!isError && call.replayOf !== undefined)
          deadLetters.resolve(call.replayOf, call.receipt);
        waiter.resolve({ receipt: call.receipt, replayOf: call.replayOf ?? "", isError, text });
      }
    }
    if (swallow) return;
    output.write(changed ? `${JSON.stringify(message)}\n` : `${line}\n`);
  };
  fromChild.on("data", (chunk: Buffer) => {
    for (const line of serverLines.push(chunk)) {
      try {
        handleServerLine(line);
      } catch (err) {
        log(
          `sayagain: failed to handle an upstream line: ${err instanceof Error ? err.message : String(err)}`,
        );
        output.write(`${line}\n`);
      }
    }
  });

  // ---- lifecycle
  const sweep = setInterval(() => {
    const cutoff = Date.now() - pendingTtlMs;
    for (const call of [...state.pending.values()])
      if (call.startedAt < cutoff)
        abandon(call, `no response from upstream within ${pendingTtlMs} ms`);
  }, 60_000);
  sweep.unref();

  const onSignal = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    childGone = true;
    const rest = serverLines.flush();
    if (rest) handleServerLine(rest);
    for (const call of [...state.pending.values()])
      abandon(call, "upstream exited before answering");
    for (const call of [...heldById.values()]) {
      if (call.held) call.held.cancelled = true;
      holds.decide(call.receipt, "reject");
      abandon(call, "upstream exited while the call was held");
    }
    clearInterval(sweep);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    control?.close();
    resolveDone(code);
  };

  child.on("error", (err) => {
    log(`sayagain: cannot run upstream "${options.command}": ${err.message}`);
    finish(1);
  });
  toChild.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") log(`sayagain: upstream stdin error: ${err.message}`);
    childGone = true;
  });
  child.on("exit", (code) => {
    exitCode = code ?? 0;
    childGone = true;
  });
  child.on("close", () => finish(exitCode ?? 0));

  return { child, holds, classifier, deadLetters, replay, done };
}
