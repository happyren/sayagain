/**
 * Storage behind the boundary: the ledger, dead letters and persisted holds.
 * JSONL files by default; SQLite (node:sqlite, Node 24+) when asked for.
 */
import { createRequire } from "node:module";
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
  decide(receipt: string, decision: Decision): void;
  pending(): Hold[];
}

export interface Stores {
  kind: "jsonl" | "sqlite" | "memory";
  ledger: Ledger;
  deadLetters: DeadLetters;
  holds?: HoldPersistence;
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

function openSqlite(path: string): SqliteDatabase | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDatabase };
    return new mod.DatabaseSync(path);
  } catch {
    return null;
  }
}

export const defaultSqlitePath = (): string => homePath("sayagain.db");

class SqliteStores implements Stores {
  readonly kind = "sqlite" as const;
  readonly ledger: Ledger;
  readonly deadLetters: DeadLetters;
  readonly holds: HoldPersistence;
  private readonly insertCall: SqliteStatement;
  private readonly selectCalls: SqliteStatement;
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL, ts TEXT NOT NULL, upstream TEXT, tool TEXT, status TEXT, is_error INTEGER, row TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_receipt ON calls(receipt);
      CREATE TABLE IF NOT EXISTS deadletters (receipt TEXT PRIMARY KEY, ts TEXT, upstream TEXT, tool TEXT, entry TEXT NOT NULL, resolved_by TEXT);
      CREATE TABLE IF NOT EXISTS holds (receipt TEXT PRIMARY KEY, upstream TEXT, created_at INTEGER, expires_at INTEGER, hold TEXT NOT NULL, decision TEXT, decided_at INTEGER);
    `);
    this.insertCall = db.prepare(
      "INSERT INTO calls (receipt, ts, upstream, tool, status, is_error, row) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectCalls = db.prepare("SELECT row FROM calls ORDER BY seq DESC LIMIT ?");
    this.ledger = {
      append: (row: LedgerRow) => {
        this.insertCall.run(
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
    const decideHold = db.prepare(
      "UPDATE holds SET decision = ?, decided_at = ? WHERE receipt = ?",
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
      decide: (receipt, decision) => {
        decideHold.run(decision, Date.now(), receipt);
      },
      pending: () => pendingHolds.all(Date.now()).map((r) => JSON.parse(String(r.hold)) as Hold),
    };
  }
  readLedger(tail = 100): LedgerRow[] {
    return this.selectCalls
      .all(tail)
      .map((r) => JSON.parse(String(r.row)) as LedgerRow)
      .reverse();
  }
  close(): void {
    this.db.close();
  }
}

export interface OpenStoresOptions {
  ledgerPath?: string;
  deadLetterPath?: string;
  sqlitePath?: string;
  log?: (line: string) => void;
}

export function openStores(
  kind: "jsonl" | "sqlite" | "memory",
  opts: OpenStoresOptions = {},
): Stores {
  if (kind === "sqlite") {
    const db = openSqlite(opts.sqlitePath ?? defaultSqlitePath());
    if (db) return new SqliteStores(db);
    opts.log?.("sayagain: node:sqlite is not available on this Node.js; using JSONL files instead");
  }
  if (kind === "memory") {
    const ledger = new MemoryLedger();
    return {
      kind: "memory",
      ledger,
      deadLetters: new DeadLetterStore(),
      readLedger: (tail) => (tail === undefined ? ledger.rows : ledger.rows.slice(-tail)),
      close: () => {},
    };
  }
  const ledger = new JsonlLedger(opts.ledgerPath ?? defaultLedgerPath());
  return {
    kind: "jsonl",
    ledger,
    deadLetters: new DeadLetterStore(opts.deadLetterPath ?? defaultDeadLetterPath()),
    readLedger: (tail) => readLedger(ledger.path, tail === undefined ? {} : { tail }),
    close: () => {},
  };
}
