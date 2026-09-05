import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Status, ToolClass } from "@sayagain/sdk";
import { homePath } from "./home.js";

/**
 * One row per outcome the boundary produced for a call. A receipt normally
 * appears once; it appears twice when an attempt failed and the call was
 * then held (the failed attempt, then the hold or the approved re-send).
 * Consumers that want one row per call keep the last row per receipt.
 */
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
  errorClass?: string;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  held?: {
    reason: string;
    mode: string;
    decision?: "approve" | "reject";
    waitedMs?: number;
    cancelled?: boolean;
  };
  duplicateOf?: string;
  attempts?: number;
  /** Repair rules applied, paths only, never values. */
  repairs?: { path: string; rule: string }[];
  replayOf?: string;
  /** Which budget a repair counted against: the client's task id, or a time window when none was given. */
  budget?: "task" | "window";
}

export interface Ledger {
  append(row: LedgerRow): void;
}

export const defaultLedgerPath = (): string => homePath("ledger.jsonl");

/** Append-only JSON lines. Durable across restarts. */
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
