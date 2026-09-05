import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Status, ToolClass } from "@sayagain/sdk";

export interface LedgerRow {
  receipt: string;
  ts: string;
  upstream: string;
  method: "tools/call";
  tool: string;
  toolClass: ToolClass;
  /** Sorted key:type entries of the arguments, never values. */
  argShape: string[];
  argsHash: string;
  hasIntent: boolean;
  task?: string;
  status: Status;
  isError: boolean;
  errorCode?: number;
  errorSignature?: string;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  held?: { reason: string; decision?: "approve" | "reject"; waitedMs?: number };
  duplicateOf?: string;
}

export interface Ledger {
  append(row: LedgerRow): void;
}

export const defaultLedgerPath = (): string => join(homedir(), ".sayagain", "ledger.jsonl");

/** Append-only JSON lines. One file, one row per call, durable across restarts. */
export class JsonlLedger implements Ledger {
  constructor(readonly path: string = defaultLedgerPath()) {
    mkdirSync(dirname(path), { recursive: true });
  }
  append(row: LedgerRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
  }
}

export class MemoryLedger implements Ledger {
  readonly rows: LedgerRow[] = [];
  append(row: LedgerRow): void {
    this.rows.push(row);
  }
}

export function readLedger(
  path: string = defaultLedgerPath(),
  opts: { tail?: number } = {},
): LedgerRow[] {
  if (!existsSync(path)) return [];
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch {
      // a torn last line from a crash is not a reason to lose the rest
    }
  }
  return opts.tail !== undefined ? rows.slice(-opts.tail) : rows;
}
