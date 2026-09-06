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
  /** The host session the call came from, when the boundary knows it. Orders calls for recovery analysis. */
  session?: string;
  /** The registry name of the boundary that recorded it (the host's key), beside the upstream's own name. */
  server?: string;
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
  /** The A/B arm the call's session was in (docs/measurement.md 5.4); absent outside an experiment. */
  arm?: "control" | "treatment";
  /** This row is the boundary's own read-back of another call's effect: that call's receipt. */
  verifies?: string;
  /** The call's outcome was unknown and the boundary read it back (spec 8.3): what it found. */
  verified?: "present" | "absent";
}

export interface Ledger {
  append(row: LedgerRow): void;
}

export const defaultLedgerPath = (): string => homePath("ledger.jsonl");

/** Append-only JSON lines. Durable across restarts. */
export class JsonlLedger implements Ledger {
  constructor(readonly path: string = defaultLedgerPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
