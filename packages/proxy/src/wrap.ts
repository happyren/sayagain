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
import type { OtlpExporter } from "./otlp.js";
import type { PolicyOptions, ToolClassifier } from "./policy.js";
import { StdioUpstream } from "./upstream-stdio.js";
import { PROXY_VERSION } from "./version.js";

export interface WrapOptions {
  /** Export one span per call to an OTLP/HTTP collector. */
  otlp?: OtlpExporter;
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

  const session = {
    id: `stdio-${process.pid}`,
    send: (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`),
  };
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
    control?.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Rows for abandoned calls are written as the upstream closes; the last spans must reach the
    // collector after that and before the process exits.
    void boundary
      .close()
      .then(() => options.otlp?.close())
      .catch(() => undefined)
      .then(() => resolveDone(exitCode));
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

  if (options.otlp) boundary.on("row", (row) => options.otlp?.record(row));
  boundary.on("upstream-closed", (_reason: string, code: number | null) => {
    exitCode = code ?? 0;
    finish();
  });
  output.on("error", () => finish());
  boundary
    .start()
    .then((result) => {
      if (result === null && !finished) {
        exitCode = 1;
        finish();
      }
    })
    .catch((err: unknown) => {
      log(
        `sayagain: could not start the upstream: ${err instanceof Error ? err.message : String(err)}`,
      );
      exitCode = 1;
      finish();
    });

  const lines = new LineSplitter();
  input.on("data", (chunk: Buffer | string) => {
    for (const line of lines.push(chunk)) boundary.handle(session, line).catch(() => undefined);
  });
  input.on("end", () => {
    // Everything the host sent is dispatched before its stdin closes the upstream's.
    const rest = lines.flush();
    if (rest) boundary.handle(session, rest).catch(() => undefined);
    void boundary.drain(session).finally(() => upstream?.end());
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
