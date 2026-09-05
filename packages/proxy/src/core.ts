/**
 * The boundary core: one upstream, any number of connected hosts (sessions),
 * every guarantee from 0.1 to 0.3 (receipts, DISREGARD, STANDBY, retry,
 * repair, dead-letter, replay) applied per call. Transports are pluggable;
 * `wrap` and the daemon are thin shells around this class.
 */
import { EventEmitter } from "node:events";
import { META } from "@sayagain/sdk";
import {
  ANNOUNCEMENT,
  abandonedResponse,
  BOUNDARY_NAME,
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
  ownId,
  ownToolsListRequest,
  type PendingCall,
  pendingFor,
  registerPending,
  rewriteServerMessage,
  shapeOf,
  withArguments,
} from "./boundary.js";
import type { ReplayOutcome } from "./control.js";
import type { DeadLetter } from "./deadletter.js";
import { DedupeCache, type Remembered } from "./dedupe.js";
import { type Hold, HoldQueue } from "./holds.js";
import {
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  parseMessage,
} from "./jsonrpc.js";
import type { Ledger } from "./ledger.js";
import { DEFAULT_POLICY, type PolicyOptions, shouldHold, ToolClassifier } from "./policy.js";
import { repairArguments } from "./repair.js";
import { resultText } from "./signature.js";
import type { DeadLetters } from "./stores.js";
import type { Session, Upstream } from "./transport.js";

export interface BoundaryCoreOptions {
  /** Host-facing name of this upstream (the host's config key). */
  name: string;
  upstream: () => Upstream;
  ledger: Ledger;
  ledgerKind: "jsonl" | "memory" | "sqlite" | "postgres";
  deadLetters: DeadLetters;
  holds?: HoldQueue;
  policy?: Partial<PolicyOptions>;
  version: string;
  announce?: boolean;
  log?: (line: string) => void;
  holdTtlMs?: number;
  warmupMs?: number;
  pendingTtlMs?: number;
  replayTimeoutMs?: number;
  /** Restart a stdio upstream that exited when the next message arrives. Default false (wrap); the daemon sets true. */
  restartUpstream?: boolean;
  clientInfo?: { name: string; version: string };
}

interface SessionEntry {
  session: Session;
  chain: Promise<void>;
}

type FailureAction = "retry" | "repair" | "hold" | "final";

export class Boundary extends EventEmitter {
  readonly name: string;
  readonly holds: HoldQueue;
  readonly classifier: ToolClassifier;
  readonly deadLetters: DeadLetters;
  readonly policy: PolicyOptions;
  private readonly ledger: Ledger;
  private readonly dedupe: DedupeCache;
  private readonly state = createState();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly idMap = new Map<string, { session: Session; clientId: JsonRpcId }>();
  private readonly reverseMap = new Map<string, { session: Session; upstreamId: JsonRpcId }>();
  private readonly settles = new Map<string, (r: Remembered | null) => void>();
  private readonly heldById = new Map<string, PendingCall>();
  private readonly repairBudget = new Map<string, number>();
  private readonly replayWaiters = new Map<
    string,
    { resolve: (o: ReplayOutcome) => void; timer: NodeJS.Timeout }
  >();
  private readonly log: (line: string) => void;
  private readonly opts: Required<
    Pick<
      BoundaryCoreOptions,
      "holdTtlMs" | "warmupMs" | "pendingTtlMs" | "replayTimeoutMs" | "announce"
    >
  > &
    BoundaryCoreOptions;
  private upstream: Upstream | undefined;
  private upstreamInit: Promise<Record<string, unknown> | null> | undefined;
  private initResult: Record<string, unknown> | null = null;
  private upstreamSeq = 0;
  private reverseSeq = 0;
  private sweep: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: BoundaryCoreOptions) {
    super();
    this.opts = {
      holdTtlMs: 3_600_000,
      warmupMs: 5000,
      pendingTtlMs: 600_000,
      replayTimeoutMs: 30_000,
      announce: true,
      ...options,
    };
    this.name = options.name;
    this.state.upstreamName = options.name;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.classifier = new ToolClassifier(this.policy.classes);
    this.dedupe = new DedupeCache(this.policy.dedupeWindowMs);
    this.holds = options.holds ?? new HoldQueue();
    this.deadLetters = options.deadLetters;
    this.ledger = options.ledger;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.sweep = setInterval(() => this.sweepPending(), 60_000);
    this.sweep.unref();
  }

  get upstreamName(): string {
    return this.state.upstreamName;
  }
  get upstreamReady(): boolean {
    return !!this.upstream?.ready;
  }
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------- upstream lifecycle

  /** Start the upstream and initialize it as the boundary's own client. Idempotent. */
  start(): Promise<Record<string, unknown> | null> {
    if (this.upstreamInit) return this.upstreamInit;
    const up = this.opts.upstream();
    this.upstream = up;
    up.onLine((line) => this.handleUpstreamLine(line));
    up.onClose((reason, code) => this.handleUpstreamClose(reason, code));
    this.upstreamInit = (async () => {
      await up.start();
      if (!up.ready) return null;
      const id = ownId(this.state, "init");
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: this.opts.clientInfo ?? { name: BOUNDARY_NAME, version: this.opts.version },
        },
      };
      this.state.initializeIds.add(keyOf(id));
      const result = await new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => {
          this.initWaiters.delete(keyOf(id));
          resolve(null);
        }, 30_000);
        timer.unref();
        this.initWaiters.set(keyOf(id), (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        if (!up.send(`${JSON.stringify(req)}\n`)) {
          clearTimeout(timer);
          this.initWaiters.delete(keyOf(id));
          resolve(null);
        }
      });
      this.initResult = result;
      if (result) {
        up.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        this.warmClassifier();
      }
      return result;
    })();
    return this.upstreamInit;
  }
  private readonly initWaiters = new Map<string, (r: Record<string, unknown> | null) => void>();

  private async ensureUpstream(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.upstreamInit && this.opts.restartUpstream)
      this.log(`sayagain: starting upstream ${this.name}`);
    const result = await this.start();
    return result !== null && !!this.upstream?.ready;
  }

  private handleUpstreamClose(reason: string, code: number | null): void {
    this.log(`sayagain: upstream ${this.state.upstreamName ?? this.name} closed: ${reason}`);
    for (const call of [...this.state.pending.values()])
      this.abandon(call, "upstream exited before answering");
    for (const call of [...this.heldById.values()]) {
      if (call.held) call.held.cancelled = true;
      this.holds.decide(call.receipt, "reject");
      this.abandon(call, "upstream exited while the call was held");
    }
    for (const w of this.initWaiters.values()) w(null);
    this.initWaiters.clear();
    this.upstream = undefined;
    this.upstreamInit = undefined;
    this.initResult = null;
    this.emit("upstream-closed", reason, code);
  }

  /** Stop the upstream and resolve once it has actually exited (or after a short grace period). */
  close(graceMs = 3000): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    const up = this.upstream;
    if (!up) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref();
      this.once("upstream-closed", () => {
        clearTimeout(timer);
        resolve();
      });
      up.stop();
    });
  }

  private sendUpstream(line: string): boolean {
    return this.upstream?.send(line) ?? false;
  }

  private warmClassifier(): void {
    this.sendUpstream(`${JSON.stringify(ownToolsListRequest(this.state))}\n`);
  }

  private untilWarm(): Promise<void> {
    return this.classifier.warm
      ? Promise.resolve()
      : Promise.race([
          this.classifier.ready,
          new Promise<void>((r) => setTimeout(r, this.opts.warmupMs).unref()),
        ]);
  }

  // ---------------------------------------------------------------- sessions

  attach(session: Session): void {
    this.sessions.set(session.id, { session, chain: Promise.resolve() });
  }

  detach(session: Session): void {
    this.sessions.delete(session.id);
    for (const [k, v] of this.idMap) if (v.session === session) this.idMap.delete(k);
    for (const [k, v] of this.reverseMap) if (v.session === session) this.reverseMap.delete(k);
  }

  /** Feed one line from a host. Lines from one session are handled strictly in order. */
  handle(session: Session, line: string): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return Promise.reject(new Error(`session ${session.id} is not attached`));
    entry.chain = entry.chain
      .then(() => this.handleClientLine(session, line))
      .catch((err: unknown) => {
        this.log(
          `sayagain: failed to handle a client line: ${err instanceof Error ? err.message : String(err)}`,
        );
        const msg = parseMessage(line);
        if (msg && !Array.isArray(msg) && isRequest(msg))
          session.send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: `Say Again: internal error while handling the request: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
      });
    return entry.chain;
  }

  /** Map a client request id to a fresh upstream id and remember the way back. */
  private mapId(session: Session, clientId: JsonRpcId): string {
    const upstreamId = `s${++this.upstreamSeq}`;
    this.idMap.set(keyOf(upstreamId), { session, clientId });
    return upstreamId;
  }

  /** Deliver a message that carries an upstream id to the session that asked, with its own id restored. */
  private deliver(msg: JsonRpcMessage): boolean {
    if (!("id" in msg) || msg.id === undefined || msg.id === null) return false;
    const key = keyOf(msg.id);
    const target = this.idMap.get(key);
    if (!target) return false;
    this.idMap.delete(key);
    target.session.send({ ...msg, id: target.clientId });
    return true;
  }

  private broadcast(msg: JsonRpcMessage): void {
    for (const { session } of this.sessions.values()) session.send(msg);
  }

  private initializeResponse(clientId: JsonRpcId): JsonRpcMessage {
    const base = this.initResult ?? {
      protocolVersion: "2026-07-28",
      capabilities: {},
      serverInfo: { name: this.name, version: "unknown" },
    };
    const result = { ...base };
    const boundary: Record<string, unknown> = {
      name: BOUNDARY_NAME,
      version: this.opts.version,
      upstream: this.state.upstreamName,
      ledger: this.opts.ledgerKind,
      shim: false,
      hold: this.policy.hold,
    };
    result._meta = {
      ...((result._meta as Record<string, unknown> | undefined) ?? {}),
      [META.boundary]: boundary,
    };
    if (this.opts.announce) {
      const existing = typeof result.instructions === "string" ? result.instructions.trimEnd() : "";
      result.instructions = existing ? `${existing}\n\n${ANNOUNCEMENT}` : ANNOUNCEMENT;
    }
    return { jsonrpc: "2.0", id: clientId, result };
  }

  private async handleClientLine(session: Session, line: string): Promise<void> {
    const msg = parseMessage(line);
    if (!msg) return;
    if (Array.isArray(msg)) {
      this.log(
        "sayagain: JSON-RPC batches are not supported by the boundary; batching was removed from MCP",
      );
      for (const m of msg)
        if (isRequest(m))
          session.send({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32600, message: "Say Again: JSON-RPC batches are not supported" },
          });
      return;
    }
    if (isRequest(msg) && msg.method === "initialize") {
      await this.ensureUpstream();
      session.send(this.initializeResponse(msg.id));
      return;
    }
    if ("method" in msg && msg.method === "notifications/initialized") return;
    if ("method" in msg && msg.method === "notifications/cancelled") {
      const rid = (msg.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (rid !== undefined && this.cancelHeld(session, rid)) return;
      const up =
        rid !== undefined
          ? [...this.idMap.entries()].find(
              ([, v]) => v.session === session && keyOf(v.clientId) === keyOf(rid),
            )
          : undefined;
      if (up) {
        const upstreamId = up[0].slice(up[0].indexOf(":") + 1);
        this.sendUpstream(
          `${JSON.stringify({ ...msg, params: { ...(msg.params ?? {}), requestId: upstreamId } })}\n`,
        );
      }
      return;
    }
    if (isResponse(msg) && msg.id !== null && msg.id !== undefined) {
      // The host answering a request the upstream made of it.
      const rev = this.reverseMap.get(keyOf(msg.id));
      if (rev) {
        this.reverseMap.delete(keyOf(msg.id));
        this.sendUpstream(`${JSON.stringify({ ...msg, id: rev.upstreamId })}\n`);
      }
      return;
    }
    if (!(await this.ensureUpstream())) {
      if (isRequest(msg))
        session.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `Say Again: upstream ${this.name} is not available` },
        });
      return;
    }
    if (isRequest(msg)) {
      const upstreamId = this.mapId(session, msg.id);
      const mapped: JsonRpcRequest = { ...msg, id: upstreamId };
      if (mapped.method === "tools/call") {
        await this.handleToolCall(mapped);
        return;
      }
      if (mapped.method === "tools/list") this.state.toolsListIds.add(keyOf(upstreamId));
      this.sendUpstream(`${JSON.stringify(mapped)}\n`);
      return;
    }
    this.sendUpstream(`${JSON.stringify(msg)}\n`);
  }

  // ---------------------------------------------------------------- calls

  private answerDuplicate(call: PendingCall, first: Remembered): void {
    const row = baseRow(call, this.state.upstreamName, "deduplicated", 0, Date.now());
    row.duplicateOf = first.receipt;
    this.record(row);
    this.deliver(duplicateResponse(call, first.receipt, first.result));
  }

  private record(row: ReturnType<typeof baseRow>): void {
    this.ledger.append(row);
    this.emit("row", row);
  }

  private settle(call: PendingCall, r: Remembered | null): void {
    const s = this.settles.get(call.receipt);
    if (s) {
      this.settles.delete(call.receipt);
      s(r);
    }
  }

  private budgetKey(call: PendingCall, now: number): string {
    if (call.task !== undefined) {
      call.budget = "task";
      return `task:${call.task}`;
    }
    call.budget = "window";
    return `window:${Math.floor(now / this.policy.repairWindowMs)}`;
  }

  private recordDeadLetter(call: PendingCall, errorClass: string, errorSignature: string): void {
    const entry: DeadLetter = {
      receipt: call.receipt,
      ts: new Date(call.startedAt).toISOString(),
      upstream: this.state.upstreamName,
      tool: call.tool,
      rawLine: call.rawLine,
      errorClass,
      errorSignature,
      attempts: call.attempts,
      repairs: call.repairs.length,
    };
    if (call.intent !== undefined) entry.intent = call.intent;
    if (call.task !== undefined) entry.task = call.task;
    this.deadLetters.add(entry);
    this.emit("dead-letter", entry);
  }

  private abandon(call: PendingCall, reason: string): void {
    this.state.pending.delete(keyOf(call.id));
    const failure: Failure = { errorClass: "retryable", signature: reason, text: reason };
    const row = failedAttemptRow(call, this.state.upstreamName, failure, 0, Date.now());
    row.status = "dead-lettered";
    this.record(row);
    this.recordDeadLetter(call, row.errorClass ?? "retryable", reason);
    this.settle(call, null);
    if (!this.state.ownIds.delete(keyOf(call.id))) this.deliver(abandonedResponse(call, reason));
    const waiter = this.replayWaiters.get(keyOf(call.id));
    if (waiter) {
      clearTimeout(waiter.timer);
      this.replayWaiters.delete(keyOf(call.id));
      waiter.resolve({
        receipt: call.receipt,
        replayOf: call.replayOf ?? "",
        isError: true,
        text: reason,
      });
    }
  }

  private forward(call: PendingCall): void {
    registerPending(this.state, call);
    if (!this.sendUpstream(call.rawLine)) this.abandon(call, "upstream is not accepting requests");
  }

  /** Park a call in a hold. Returns as soon as the hold exists; the decision is handled asynchronously. */
  private park(call: PendingCall, reason: string, mode: HoldMode): void {
    const createdAt = Date.now();
    const expiresAt = createdAt + this.policy.holdWaitMs + this.opts.holdTtlMs;
    const hold: Hold = {
      receipt: call.receipt,
      tool: call.tool,
      toolClass: call.toolClass,
      reason,
      arguments: call.arguments,
      createdAt,
      expiresAt,
      upstream: this.name,
      mode,
    };
    if (call.intent !== undefined) hold.intent = call.intent;
    this.holds.create(hold);
    this.emit("hold", hold);
    call.held = { reason, mode };
    this.heldById.set(keyOf(call.id), call);
    const finishHold = () => {
      this.holds.forget(call.receipt);
      this.heldById.delete(keyOf(call.id));
    };
    const heldRow = (now: number) => {
      const row = baseRow(call, this.state.upstreamName, "held", 0, now);
      if (call.lastFailure) {
        row.errorClass = call.lastFailure.errorClass;
        row.errorSignature = call.lastFailure.signature;
      }
      return row;
    };
    const answerHeld = (rejected: boolean) => {
      if (call.held?.cancelled) return;
      const o: Parameters<typeof heldResponse>[3] = { rejected, mode };
      if (call.lastFailure) o.failure = call.lastFailure;
      if (call.repairs.length) o.repairs = call.repairs;
      this.deliver(heldResponse(call, reason, expiresAt, o));
    };
    const send = (afterWait: boolean) => {
      if (call.held) call.held.decision = "approve";
      if (mode !== "pre") call.attempts++;
      if (afterWait) this.state.ownIds.add(keyOf(call.id));
      this.forward(call);
    };
    void (async () => {
      const decision = await this.holds.waitFor(call.receipt, this.policy.holdWaitMs);
      if (call.held) call.held.waitedMs = Date.now() - createdAt;
      if (decision === "approve") {
        finishHold();
        send(false);
        return;
      }
      if (decision === "reject") {
        if (call.held) call.held.decision = "reject";
        finishHold();
        this.record(heldRow(Date.now()));
        answerHeld(true);
        this.settle(call, null);
        return;
      }
      this.record(heldRow(Date.now()));
      answerHeld(false);
      this.settle(call, null);
      const later = await this.holds.waitFor(call.receipt, this.opts.holdTtlMs);
      finishHold();
      if (later === "approve") send(true);
      else if (later === "reject" && call.held) {
        call.held.decision = "reject";
        this.record(heldRow(Date.now()));
      }
    })().catch((err: unknown) =>
      this.log(
        `sayagain: hold ${call.receipt} failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  private cancelHeld(session: Session, clientId: JsonRpcId): boolean {
    for (const [upKey, target] of this.idMap) {
      if (target.session !== session || keyOf(target.clientId) !== keyOf(clientId)) continue;
      const call = this.heldById.get(upKey);
      if (!call?.held) return false;
      call.held.cancelled = true;
      this.holds.decide(call.receipt, "reject");
      this.idMap.delete(upKey);
      return true;
    }
    return false;
  }

  private async handleToolCall(msg: JsonRpcRequest): Promise<void> {
    const tool = typeof msg.params?.name === "string" ? msg.params.name : "";
    await this.untilWarm();
    if (!this.classifier.warm) this.warmClassifier();
    const text = `${JSON.stringify(msg)}\n`;
    const call = describeCall(msg, text, this.classifier.classOf(tool), Buffer.byteLength(text));

    // DISREGARD: one identity per call; a concurrent duplicate waits for the first result.
    const key = DedupeCache.keyFor(call);
    if (key !== null) {
      const hit = this.dedupe.lookup(key);
      if (hit) {
        this.answerDuplicate(call, hit);
        return;
      }
      const reservation = this.dedupe.reserve(key);
      if ("existing" in reservation) {
        const first = await reservation.existing;
        if (first) {
          this.answerDuplicate(call, first);
          return;
        }
        const again = this.dedupe.reserve(key);
        if ("settle" in again) this.settles.set(call.receipt, again.settle);
      } else {
        this.settles.set(call.receipt, reservation.settle);
      }
    }

    // STANDBY: hold before leaving.
    if (shouldHold(call.toolClass, this.policy.hold)) {
      const reason =
        this.policy.hold === "always"
          ? "policy holds every call that can change the world"
          : "tool is classified destructive";
      this.park(call, reason, "pre");
      return;
    }
    this.forward(call);
  }

  private decideOnFailure(call: PendingCall, failure: Failure, now: number): FailureAction {
    if (call.replayOf !== undefined) return "final";
    if (failure.errorClass === "retryable") {
      const safe = call.toolClass === "read-only" || call.toolClass === "idempotent-write";
      if (safe) return call.attempts < this.policy.retryAttempts ? "retry" : "final";
      return this.policy.hold === "never" || call.held ? "final" : "hold";
    }
    if (failure.errorClass === "coercible" && this.policy.repair && call.repairs.length === 0) {
      const used = this.repairBudget.get(this.budgetKey(call, now)) ?? 0;
      if (used < this.policy.repairsPerTask && this.classifier.schemaOf(call.tool) !== undefined)
        return "repair";
    }
    return "final";
  }

  /** Try to recover a failed call. Returns true when the response was consumed and must not be forwarded. */
  private recover(call: PendingCall, failure: Failure, bytes: number): boolean {
    const now = Date.now();
    const action = this.decideOnFailure(call, failure, now);
    if (action === "retry") {
      call.attempts++;
      const delay = this.policy.retryBaseMs * 2 ** (call.attempts - 2);
      setTimeout(() => {
        if (!this.sendUpstream(call.rawLine))
          this.abandon(call, "upstream is not accepting requests");
      }, delay);
      return true;
    }
    if (action === "repair") {
      const repaired = repairArguments(call.arguments, this.classifier.schemaOf(call.tool));
      if (!repaired) return false;
      call.repairs = repaired.changes;
      call.arguments = repaired.arguments;
      call.argShape = shapeOf(repaired.arguments);
      call.argsHash = hashArgs(repaired.arguments);
      call.rawLine = `${withArguments(call.rawLine, repaired.arguments)}\n`;
      const k = this.budgetKey(call, now);
      this.repairBudget.set(k, (this.repairBudget.get(k) ?? 0) + 1);
      const safe = call.toolClass === "read-only" || call.toolClass === "idempotent-write";
      if (safe || this.policy.hold === "never") {
        call.attempts++;
        if (!this.sendUpstream(call.rawLine))
          this.abandon(call, "upstream is not accepting requests");
        return true;
      }
      this.state.pending.delete(keyOf(call.id));
      call.lastFailure = failure;
      this.record(failedAttemptRow(call, this.state.upstreamName, failure, bytes, now));
      this.park(
        call,
        `arguments repaired (${repaired.changes.map((c) => `${c.path} ${c.rule}`).join(", ")}); approve to send`,
        "repaired",
      );
      return true;
    }
    if (action === "hold") {
      this.state.pending.delete(keyOf(call.id));
      call.lastFailure = failure;
      this.record(failedAttemptRow(call, this.state.upstreamName, failure, bytes, now));
      this.park(call, `write failed with unknown outcome: ${failure.signature}`, "unknown-outcome");
      return true;
    }
    return false;
  }

  replay(receipt: string, args?: unknown): Promise<ReplayOutcome | null> {
    const entry = this.deadLetters.get(receipt);
    if (!entry) return Promise.resolve(null);
    const original = JSON.parse(entry.rawLine) as JsonRpcRequest;
    const id = ownId(this.state, "replay");
    const rawLine = `${withArguments(entry.rawLine, args ?? original.params?.arguments, id)}\n`;
    const req = JSON.parse(rawLine) as JsonRpcRequest;
    const call = describeCall(
      req,
      rawLine,
      this.classifier.classOf(entry.tool),
      Buffer.byteLength(rawLine),
    );
    call.replayOf = receipt;
    return new Promise((resolve) => {
      void this.ensureUpstream().then((ok) => {
        if (!ok) {
          resolve({
            receipt: call.receipt,
            replayOf: receipt,
            isError: true,
            text: `upstream ${this.name} is not available`,
          });
          return;
        }
        const timer = setTimeout(() => {
          if (this.replayWaiters.delete(keyOf(id)))
            this.abandon(call, `no response from upstream within ${this.opts.replayTimeoutMs} ms`);
        }, this.opts.replayTimeoutMs);
        timer.unref();
        this.replayWaiters.set(keyOf(id), { resolve, timer });
        this.forward(call);
      });
    });
  }

  private sweepPending(): void {
    const cutoff = Date.now() - this.opts.pendingTtlMs;
    for (const call of [...this.state.pending.values()])
      if (call.startedAt < cutoff)
        this.abandon(call, `no response from upstream within ${this.opts.pendingTtlMs} ms`);
  }

  // ---------------------------------------------------------------- upstream -> hosts

  private handleUpstreamLine(line: string): void {
    try {
      this.processUpstreamLine(line);
    } catch (err) {
      this.log(
        `sayagain: failed to handle an upstream line: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private processUpstreamLine(line: string): void {
    const msg = parseMessage(line);
    if (!msg || Array.isArray(msg)) return;
    const bytes = Buffer.byteLength(line) + 1;

    // A request the upstream makes of its client (sampling, roots, elicitation).
    if (isRequest(msg)) {
      const [only] = [...this.sessions.values()];
      if (this.sessions.size === 1 && only) {
        const reverseId = `r${++this.reverseSeq}`;
        this.reverseMap.set(keyOf(reverseId), { session: only.session, upstreamId: msg.id });
        only.session.send({ ...msg, id: reverseId });
      } else {
        this.sendUpstream(
          `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Say Again: ${msg.method} is not routed when ${this.sessions.size} hosts share this upstream` } })}\n`,
        );
      }
      return;
    }
    if ("method" in msg && !isResponse(msg)) {
      if (msg.method === "notifications/tools/list_changed") this.warmClassifier();
      this.broadcast(msg);
      return;
    }
    if (!isResponse(msg) || msg.id === null) return;

    // The boundary's own initialize.
    const initWaiter = this.initWaiters.get(keyOf(msg.id));
    if (initWaiter) {
      this.initWaiters.delete(keyOf(msg.id));
      this.state.initializeIds.delete(keyOf(msg.id));
      this.state.ownIds.delete(keyOf(msg.id));
      const result =
        typeof msg.result === "object" && msg.result !== null
          ? (msg.result as Record<string, unknown>)
          : null;
      const serverInfo = result?.serverInfo as { name?: unknown } | undefined;
      if (serverInfo && typeof serverInfo.name === "string")
        this.state.upstreamName = serverInfo.name;
      initWaiter(result);
      return;
    }

    const pending = pendingFor(msg, this.state);
    const failure = pending ? failureOf(msg) : null;
    if (pending && failure && this.recover(pending, failure, bytes)) return;

    const opts = {
      version: this.opts.version,
      ledgerKind: this.opts.ledgerKind,
      announce: this.opts.announce,
      shim: false,
      hold: this.policy.hold,
      rewriteErrors: this.policy.rewriteErrors,
    };
    const { message, swallow, row, tools, probed, remember, call } = rewriteServerMessage(
      msg,
      this.state,
      opts,
      bytes,
    );
    if (tools !== undefined) this.classifier.learn(tools);
    else if (probed) this.classifier.markProbed();
    if (row) this.record(row);
    if (row && call && row.status === "dead-lettered")
      this.recordDeadLetter(call, row.errorClass ?? "other", row.errorSignature ?? "");
    if (call) {
      if (remember) {
        const key = DedupeCache.keyFor(call);
        const remembered: Remembered = {
          receipt: call.receipt,
          result: remember.result,
          at: Date.now(),
        };
        if (key !== null)
          this.dedupe.remember(key, remembered.receipt, remembered.result, remembered.at);
        this.settle(call, remembered);
      } else this.settle(call, null);
      const waiter = this.replayWaiters.get(keyOf(call.id));
      if (waiter) {
        clearTimeout(waiter.timer);
        this.replayWaiters.delete(keyOf(call.id));
        const result = "result" in message ? message.result : undefined;
        const text =
          "error" in message && message.error
            ? String(message.error.message)
            : resultText(result).slice(0, 500);
        const isError = row?.isError ?? true;
        if (!isError && call.replayOf !== undefined)
          this.deadLetters.resolve(call.replayOf, call.receipt);
        waiter.resolve({ receipt: call.receipt, replayOf: call.replayOf ?? "", isError, text });
      }
    }
    if (swallow) return;
    this.deliver(message);
  }
}
