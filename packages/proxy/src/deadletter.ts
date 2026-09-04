/** UNABLE: calls whose retries and repairs are exhausted, kept with intent for replay. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
}

export const defaultDeadLetterPath = (): string => join(homedir(), ".sayagain", "deadletter.jsonl");

export class DeadLetterStore {
  private readonly entries = new Map<string, DeadLetter>();
  constructor(readonly path?: string) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }
  add(entry: DeadLetter): void {
    this.entries.set(entry.receipt, entry);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
  get(receipt: string): DeadLetter | undefined {
    return this.entries.get(receipt);
  }
  list(): DeadLetter[] {
    return [...this.entries.values()];
  }
}

export function readDeadLetters(path: string = defaultDeadLetterPath()): DeadLetter[] {
  if (!existsSync(path)) return [];
  const out: DeadLetter[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as DeadLetter);
    } catch {
      // torn line
    }
  }
  return out;
}
