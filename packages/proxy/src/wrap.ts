/**
 * `sayagain wrap`: the boundary in-process around one stdio MCP server.
 * Bytes pass through unchanged except for the rewrites in boundary.ts, the
 * DISREGARD short-circuit for duplicates, and STANDBY holds.
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
  heldResponse,
  observeClientMessage,
  ownToolsListRequest,
  registerPending,
  rewriteServerMessage,
} from "./boundary.js";
import { startControlServer } from "./control.js";
import { DedupeCache } from "./dedupe.js";
import { HoldQueue } from "./holds.js";
import { isRequest, LineSplitter, parseMessage } from "./jsonrpc.js";
import { JsonlLedger, type Ledger } from "./ledger.js";
import { DEFAULT_POLICY, type PolicyOptions, shouldHold, ToolClassifier } from "./policy.js";
import { PROXY_VERSION } from "./version.js";

export interface WrapOptions {
  command: string;
  args?: string[];
  /** Defaults to process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
  ledger?: Ledger;
  ledgerKind?: BoundaryOptions["ledgerKind"];
  upstreamName?: string;
  announce?: boolean;
  env?: NodeJS.ProcessEnv;
  policy?: Partial<PolicyOptions>;
  /** Start the control socket so `sayagain holds/approve/reject` can reach this process. Default true. */
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
  /** Resolves with the child's exit code once it has exited and output is flushed. */
  done: Promise<number>;
}

export function wrap(options: WrapOptions): Wrapped {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ledger = options.ledger ?? new JsonlLedger();
  const policy: PolicyOptions = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const state = createState(options.upstreamName ?? "upstream");
  const classifier = new ToolClassifier(policy.classes);
  const dedupe = new DedupeCache(policy.dedupeWindowMs);
  const holds = new HoldQueue();
  const holdTtlMs = options.holdTtlMs ?? 3_600_000;
  const warmupMs = options.warmupMs ?? 2000;
  const boundary: BoundaryOptions = {
    version: PROXY_VERSION,
    ledgerKind: options.ledgerKind ?? (ledger instanceof JsonlLedger ? "jsonl" : "memory"),
    announce: options.announce ?? true,
    shim: false,
    hold: policy.hold,
  };

  const child = spawn(options.command, options.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  const toChild = child.stdin;
  const fromChild = child.stdout;
  if (!toChild || !fromChild) throw new Error("child process has no stdio pipes");

  let control: Server | undefined;
  if (options.control ?? true) control = startControlServer(holds);

  const respond = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  const warmClassifier = () => toChild.write(`${JSON.stringify(ownToolsListRequest(state))}\n`);
  const untilWarm = () =>
    classifier.warm
      ? Promise.resolve()
      : Promise.race([classifier.ready, new Promise<void>((r) => setTimeout(r, warmupMs))]);

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
        // Executed after the agent moved on: the result reaches the ledger, not the model (replay in 0.3).
        call.held.decision = "approve";
        registerPending(state, call);
        toChild.write(call.rawLine);
      }
      return;
    }

    registerPending(state, call);
    toChild.write(text);
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
      const { message, changed, swallow, row, tools, remember } = rewriteServerMessage(
        msg,
        state,
        boundary,
        bytes,
      );
      if (tools !== undefined) classifier.learn(tools);
      if (swallow) continue;
      if (row) ledger.append(row);
      if (remember) {
        const { call, result } = remember;
        if (call.idempotencyKey !== undefined)
          dedupe.remember(DedupeCache.keyFor(call.tool, call.idempotencyKey), call.receipt, result);
        if (call.toolClass !== "read-only")
          dedupe.remember(
            DedupeCache.fingerprintFor(call.tool, call.argsHash),
            call.receipt,
            result,
          );
      }
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

  return { child, holds, classifier, done };
}
