/** UNABLE: calls whose retries and repairs are exhausted, kept with intent for replay. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { homePath } from "./home.js";

export interface DeadLetter {
  receipt: string;
  ts: string;
  upstream: string;
  tool: string;
  /** The last request line sent upstream (arguments included; the operator's trust domain). */
  rawLine: string;
  intent?: string;
  task?: string;
  errorClass: string;
  errorSignature: string;
  attempts: number;
  repairs: number;
  /** Receipt of the replay that resolved it, once one succeeded. */
  resolvedBy?: string;
}

export const defaultDeadLetterPath = (): string => homePath("deadletter.jsonl");

/** Read every entry and fold resolutions: a later line for the same receipt replaces the earlier one. */
export function readDeadLetters(
  path: string = defaultDeadLetterPath(),
  opts: { includeResolved?: boolean } = {},
): DeadLetter[] {
  if (!existsSync(path)) return [];
  const byReceipt = new Map<string, DeadLetter>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as DeadLetter;
      byReceipt.set(entry.receipt, entry);
    } catch {
      // torn line
    }
  }
  const all = [...byReceipt.values()];
  return opts.includeResolved ? all : all.filter((d) => d.resolvedBy === undefined);
}

/** In-memory index over an append-only JSONL file; hydrated on construction so replay survives restarts. */
export class DeadLetterStore {
  private readonly entries = new Map<string, DeadLetter>();
  constructor(readonly path?: string) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      for (const d of readDeadLetters(path, { includeResolved: true }))
        this.entries.set(d.receipt, d);
    }
  }
  private persist(entry: DeadLetter): void {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
  add(entry: DeadLetter): void {
    this.entries.set(entry.receipt, entry);
    this.persist(entry);
  }
  get(receipt: string): DeadLetter | undefined {
    const d = this.entries.get(receipt);
    return d && d.resolvedBy === undefined ? d : undefined;
  }
  /** Mark an entry resolved by a successful replay. It leaves list() but stays in the file. */
  resolve(receipt: string, resolvedBy: string): boolean {
    const d = this.entries.get(receipt);
    if (!d || d.resolvedBy !== undefined) return false;
    const resolved = { ...d, resolvedBy };
    this.entries.set(receipt, resolved);
    this.persist(resolved);
    return true;
  }
  list(): DeadLetter[] {
    return [...this.entries.values()].filter((d) => d.resolvedBy === undefined);
  }
}
