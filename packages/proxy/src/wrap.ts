/**
 * `sayagain wrap`: the boundary in-process around one stdio MCP server,
 * with the host on this process's own stdin and stdout.
 */
import type { Readable, Writable } from "node:stream";
import { type DeadLetterSummary, startControlServer, summarizeDeadLetter } from "./control.js";
import { Boundary } from "./core.js";
import { DeadLetterStore } from "./deadletter.js";
import type { HoldQueue } from "./holds.js";
import { LineSplitter } from "./jsonrpc.js";
import { JsonlLedger, type Ledger } from "./ledger.js";
import type { PolicyOptions, ToolClassifier } from "./policy.js";
import { StdioUpstream } from "./upstream-stdio.js";
import { PROXY_VERSION } from "./version.js";

export interface WrapOptions {
  command: string;
  args?: string[];
  /** Defaults to process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
  ledger?: Ledger;
  ledgerKind?: "jsonl" | "memory" | "sqlite" | "postgres";
  /** Dead-letter file; omit for memory only. */
  deadLetterPath?: string;
  deadLetters?: DeadLetterStore;
  upstreamName?: string;
  announce?: boolean;
  env?: NodeJS.ProcessEnv;
  policy?: Partial<PolicyOptions>;
  /** Start the control socket so the CLI can reach this process. Default true. */
  control?: boolean;
  holdTtlMs?: number;
  warmupMs?: number;
  pendingTtlMs?: number;
  replayTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface Wrapped {
  boundary: Boundary;
  holds: HoldQueue;
  classifier: ToolClassifier;
  deadLetters: DeadLetterStore;
  replay: Boundary["replay"];
  /** Signal the upstream process. */
  kill: (signal?: NodeJS.Signals) => void;
  /** Resolves with the upstream's exit code once it has exited and output is flushed. */
  done: Promise<number>;
}

export function wrap(options: WrapOptions): Wrapped {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ledger = options.ledger ?? new JsonlLedger();
  const deadLetters = options.deadLetters ?? new DeadLetterStore(options.deadLetterPath);
  let upstream: StdioUpstream | undefined;
  const coreOptions: ConstructorParameters<typeof Boundary>[0] = {
    name: options.upstreamName ?? "upstream",
    upstream: () => {
      upstream = new StdioUpstream({
        command: options.command,
        args: options.args ?? [],
        env: options.env ?? process.env,
        log,
      });
      return upstream;
    },
    ledger,
    ledgerKind: options.ledgerKind ?? (ledger instanceof JsonlLedger ? "jsonl" : "memory"),
    deadLetters,
    version: PROXY_VERSION,
    announce: options.announce ?? true,
    log,
  };
  if (options.policy) coreOptions.policy = options.policy;
  if (options.holdTtlMs !== undefined) coreOptions.holdTtlMs = options.holdTtlMs;
  if (options.warmupMs !== undefined) coreOptions.warmupMs = options.warmupMs;
  if (options.pendingTtlMs !== undefined) coreOptions.pendingTtlMs = options.pendingTtlMs;
  if (options.replayTimeoutMs !== undefined) coreOptions.replayTimeoutMs = options.replayTimeoutMs;
  const boundary = new Boundary(coreOptions);

  const session = { id: "stdio", send: (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`) };
  boundary.attach(session);

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let exitCode = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void boundary.close();
    control?.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    resolveDone(exitCode);
  };

  const control =
    (options.control ?? true)
      ? startControlServer(boundary.holds, undefined, {
          deadletters: (): DeadLetterSummary[] =>
            deadLetters.list().map((d) => summarizeDeadLetter(d, process.pid)),
          replay: (receipt, args) => boundary.replay(receipt, args),
        })
      : undefined;

  const onSignal = (signal: NodeJS.Signals) => () => upstream?.kill(signal);
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  boundary.on("upstream-closed", (_reason: string, code: number | null) => {
    exitCode = code ?? 0;
    finish();
  });
  void boundary.start().then((result) => {
    if (result === null && !finished) {
      exitCode = 1;
      finish();
    }
  });

  const lines = new LineSplitter();
  input.on("data", (chunk: Buffer | string) => {
    for (const line of lines.push(chunk)) void boundary.handle(session, line);
  });
  input.on("end", () => {
    const rest = lines.flush();
    const tail = rest ? boundary.handle(session, rest) : Promise.resolve();
    void tail.finally(() => upstream?.end());
  });

  return {
    boundary,
    holds: boundary.holds,
    classifier: boundary.classifier,
    deadLetters,
    replay: (r, a) => boundary.replay(r, a),
    kill: (signal) => upstream?.kill(signal),
    done,
  };
}
