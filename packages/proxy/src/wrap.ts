/**
 * `sayagain wrap`: the boundary in-process around one stdio MCP server.
 * Bytes pass through unchanged except for the two rewrites in boundary.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  type BoundaryOptions,
  createState,
  observeClientMessage,
  rewriteServerMessage,
} from "./boundary.js";
import { LineSplitter, parseMessage } from "./jsonrpc.js";
import { JsonlLedger, type Ledger } from "./ledger.js";
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
}

export interface Wrapped {
  child: ChildProcess;
  /** Resolves with the child's exit code once it has exited and output is flushed. */
  done: Promise<number>;
}

export function wrap(options: WrapOptions): Wrapped {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ledger = options.ledger ?? new JsonlLedger();
  const state = createState(options.upstreamName ?? "upstream");
  const boundary: BoundaryOptions = {
    version: PROXY_VERSION,
    ledgerKind: options.ledgerKind ?? (ledger instanceof JsonlLedger ? "jsonl" : "memory"),
    announce: options.announce ?? true,
    shim: false,
  };

  const child = spawn(options.command, options.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  const toChild = child.stdin;
  const fromChild = child.stdout;
  if (!toChild || !fromChild) throw new Error("child process has no stdio pipes");

  const clientLines = new LineSplitter();
  input.on("data", (chunk: Buffer | string) => {
    for (const line of clientLines.push(chunk)) {
      const text = `${line}\n`;
      const msg = parseMessage(line);
      if (msg && !Array.isArray(msg)) observeClientMessage(msg, state, Buffer.byteLength(text));
      toChild.write(text);
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
      const { message, changed, row } = rewriteServerMessage(msg, state, boundary, bytes);
      if (row) ledger.append(row);
      output.write(changed ? `${JSON.stringify(message)}\n` : `${line}\n`);
    }
  });

  const done = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      const rest = serverLines.flush();
      if (rest) output.write(rest);
      resolve(code ?? 0);
    });
  });

  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  return { child, done };
}
