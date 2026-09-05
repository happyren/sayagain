/**
 * Storage behind the boundary: the ledger, dead letters and persisted holds.
 * JSONL files by default; SQLite (node:sqlite, Node 22.13+) when asked for.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { type DeadLetter, DeadLetterStore, defaultDeadLetterPath } from "./deadletter.js";
import type { Decision, Hold } from "./holds.js";
import { homePath } from "./home.js";
import {
  defaultLedgerPath,
  JsonlLedger,
  type Ledger,
  type LedgerRow,
  MemoryLedger,
  readLedger,
} from "./ledger.js";

export interface DeadLetters {
  add(entry: DeadLetter): void;
  get(receipt: string): DeadLetter | undefined;
  resolve(receipt: string, resolvedBy: string): boolean;
  list(): DeadLetter[];
}

export interface HoldPersistence {
  save(hold: Hold): void;
  decide(receipt: string, decision: Decision, decidedAt?: number): void;
  pending(): Hold[];
}

export type StoreKind = "jsonl" | "sqlite" | "memory";

export interface Stores {
  kind: StoreKind;
  ledger: Ledger;
  deadLetters: DeadLetters;
  holds: HoldPersistence;
  /** The last `tail` rows in ledger order; every row when `tail` is undefined; none when it is 0. */
  readLedger(tail?: number): LedgerRow[];
  close(): void;
}

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): Record<string, unknown>[];
  get(...args: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** True when this Node.js ships node:sqlite. */
export function sqliteAvailable(): boolean {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
}

function loadSqlite(): { DatabaseSync: new (p: string) => SqliteDatabase } {
  const require = createRequire(import.meta.url);
  // node:sqlite prints an ExperimentalWarning at load on 22.13 to 24; it is stable enough for a
  // local ledger, and the warning would land in the host's log on every start.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
    if (/SQLite is an experimental feature/.test(text)) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDatabase };
  } finally {
    process.emitWarning = emit;
  }
}

export const defaultSqlitePath = (): string => homePath("sayagain.db");
export const defaultHoldsPath = (): string => homePath("holds.jsonl");

const tailOf = <T>(rows: T[], tail: number | undefined): T[] => {
  if (tail === undefined) return rows;
  const n = Math.max(0, Math.floor(tail));
  return n === 0 ? [] : rows.slice(-n);
};

class SqliteStores implements Stores {
  readonly kind = "sqlite" as const;
  readonly ledger: Ledger;
  readonly deadLetters: DeadLetters;
  readonly holds: HoldPersistence;
  private readonly selectCalls: SqliteStatement;
  private open = true;
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL, ts TEXT NOT NULL, upstream TEXT, tool TEXT, status TEXT, is_error INTEGER, row TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_receipt ON calls(receipt);
      CREATE TABLE IF NOT EXISTS deadletters (receipt TEXT PRIMARY KEY, ts TEXT, upstream TEXT, tool TEXT, entry TEXT NOT NULL, resolved_by TEXT);
      CREATE TABLE IF NOT EXISTS holds (receipt TEXT PRIMARY KEY, upstream TEXT, created_at INTEGER, expires_at INTEGER, hold TEXT NOT NULL, decision TEXT, decided_at INTEGER);
    `);
    const insertCall = db.prepare(
      "INSERT INTO calls (receipt, ts, upstream, tool, status, is_error, row) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectCalls = db.prepare("SELECT row FROM calls ORDER BY seq DESC LIMIT ?");
    this.ledger = {
      append: (row: LedgerRow) => {
        insertCall.run(
          row.receipt,
          row.ts,
          row.upstream,
          row.tool,
          row.status,
          row.isError ? 1 : 0,
          JSON.stringify(row),
        );
      },
    };
    const insertDl = db.prepare(
      "INSERT OR REPLACE INTO deadletters (receipt, ts, upstream, tool, entry, resolved_by) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const getDl = db.prepare("SELECT entry, resolved_by FROM deadletters WHERE receipt = ?");
    const listDl = db.prepare(
      "SELECT entry FROM deadletters WHERE resolved_by IS NULL ORDER BY ts",
    );
    const resolveDl = db.prepare(
      "UPDATE deadletters SET resolved_by = ?, entry = ? WHERE receipt = ? AND resolved_by IS NULL",
    );
    this.deadLetters = {
      add: (e) => {
        insertDl.run(e.receipt, e.ts, e.upstream, e.tool, JSON.stringify(e), e.resolvedBy ?? null);
      },
      get: (receipt) => {
        const r = getDl.get(receipt);
        return r && r.resolved_by === null
          ? (JSON.parse(String(r.entry)) as DeadLetter)
          : undefined;
      },
      resolve: (receipt, by) => {
        const r = getDl.get(receipt);
        if (!r || r.resolved_by !== null) return false;
        const entry = { ...(JSON.parse(String(r.entry)) as DeadLetter), resolvedBy: by };
        resolveDl.run(by, JSON.stringify(entry), receipt);
        return true;
      },
      list: () => listDl.all().map((r) => JSON.parse(String(r.entry)) as DeadLetter),
    };
    const saveHold = db.prepare(
      "INSERT OR REPLACE INTO holds (receipt, upstream, created_at, expires_at, hold, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const getHold = db.prepare("SELECT hold FROM holds WHERE receipt = ?");
    const decideHold = db.prepare(
      "UPDATE holds SET decision = ?, decided_at = ?, hold = ? WHERE receipt = ?",
    );
    const pendingHolds = db.prepare(
      "SELECT hold FROM holds WHERE decision IS NULL AND expires_at > ? ORDER BY created_at",
    );
    this.holds = {
      save: (h) => {
        saveHold.run(
          h.receipt,
          h.upstream ?? null,
          h.createdAt,
          h.expiresAt,
          JSON.stringify(h),
          h.decision ?? null,
          h.decidedAt ?? null,
        );
      },
      decide: (receipt, decision, decidedAt = Date.now()) => {
        const r = getHold.get(receipt);
        if (!r) return;
        const hold = { ...(JSON.parse(String(r.hold)) as Hold), decision, decidedAt };
        decideHold.run(decision, decidedAt, JSON.stringify(hold), receipt);
      },
      pending: () => pendingHolds.all(Date.now()).map((r) => JSON.parse(String(r.hold)) as Hold),
    };
  }
  readLedger(tail?: number): LedgerRow[] {
    const limit = tail === undefined ? -1 : Math.max(0, Math.floor(tail));
    if (limit === 0) return [];
    return this.selectCalls
      .all(limit)
      .map((r) => JSON.parse(String(r.row)) as LedgerRow)
      .reverse();
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}

/** Holds in a JSONL file: one line per hold, one line per decision; `pending()` replays the file. */
export class JsonlHolds implements HoldPersistence {
  constructor(readonly path: string) {}
  private write(line: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
  save(hold: Hold): void {
    this.write({ type: "hold", hold });
  }
  decide(receipt: string, decision: Decision, decidedAt = Date.now()): void {
    this.write({ type: "decision", receipt, decision, decidedAt });
  }
  pending(): Hold[] {
    if (!existsSync(this.path)) return [];
    const holds = new Map<string, Hold>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: {
        type: string;
        hold?: Hold;
        receipt?: string;
        decision?: Decision;
        decidedAt?: number;
      };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.type === "hold" && entry.hold) holds.set(entry.hold.receipt, entry.hold);
      else if (entry.type === "decision" && entry.receipt) holds.delete(entry.receipt);
    }
    const now = Date.now();
    return [...holds.values()].filter((h) => h.decision === undefined && h.expiresAt > now);
  }
}

export class MemoryHolds implements HoldPersistence {
  readonly holds = new Map<string, Hold>();
  save(hold: Hold): void {
    this.holds.set(hold.receipt, { ...hold });
  }
  decide(receipt: string, decision: Decision, decidedAt = Date.now()): void {
    const h = this.holds.get(receipt);
    if (h) Object.assign(h, { decision, decidedAt });
  }
  pending(): Hold[] {
    const now = Date.now();
    return [...this.holds.values()].filter((h) => h.decision === undefined && h.expiresAt > now);
  }
}

export interface OpenStoresOptions {
  ledgerPath?: string;
  deadLetterPath?: string;
  holdsPath?: string;
  sqlitePath?: string;
  log?: (line: string) => void;
}

/**
 * Open the stores of one kind. "sqlite" falls back to JSONL only when this Node.js has no
 * node:sqlite; any other failure (unwritable directory, corrupt file) is thrown.
 */
export function openStores(kind: StoreKind, opts: OpenStoresOptions = {}): Stores {
  if (kind === "sqlite") {
    let mod: ReturnType<typeof loadSqlite> | null = null;
    try {
      mod = loadSqlite();
    } catch {
      opts.log?.(
        "sayagain: this Node.js has no node:sqlite (needs 22.13 or newer); using JSONL files instead",
      );
    }
    if (mod) {
      const path = opts.sqlitePath ?? defaultSqlitePath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const db = new mod.DatabaseSync(path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort; the home directory is 0700 anyway
      }
      return new SqliteStores(db);
    }
  }
  if (kind === "memory") {
    const ledger = new MemoryLedger();
    return {
      kind: "memory",
      ledger,
      deadLetters: new DeadLetterStore(),
      holds: new MemoryHolds(),
      readLedger: (tail) => tailOf(ledger.rows, tail),
      close: () => {},
    };
  }
  const ledger = new JsonlLedger(opts.ledgerPath ?? defaultLedgerPath());
  return {
    kind: "jsonl",
    ledger,
    deadLetters: new DeadLetterStore(opts.deadLetterPath ?? defaultDeadLetterPath()),
    holds: new JsonlHolds(opts.holdsPath ?? defaultHoldsPath()),
    readLedger: (tail) =>
      tail === undefined ? readLedger(ledger.path, {}) : tailOf(readLedger(ledger.path, {}), tail),
    close: () => {},
  };
}
