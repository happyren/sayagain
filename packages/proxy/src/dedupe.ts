/** DISREGARD: remember results by idempotency key, or by write fingerprint when no key was given. */

export interface Remembered {
  receipt: string;
  result: unknown;
  at: number;
}

export interface DedupeSubject {
  tool: string;
  toolClass: string;
  idempotencyKey?: string;
  /** Hash of the arguments as the client sent them, never of repaired arguments. */
  clientArgsHash: string;
  task?: string;
}

export type Reservation =
  | { existing: Promise<Remembered | null> }
  | { settle: (r: Remembered | null) => void };

export class DedupeCache {
  private readonly entries = new Map<string, Remembered>();
  /** Calls forwarded but not yet answered, so a concurrent duplicate can wait for the first result. */
  private readonly inflight = new Map<string, Promise<Remembered | null>>();
  constructor(private readonly windowMs: number) {}

  /** The single key a call dedupes on: its idempotency key, else a write fingerprint, else nothing. */
  static keyFor(subject: DedupeSubject): string | null {
    if (subject.idempotencyKey !== undefined)
      return `key:${subject.tool}:${subject.idempotencyKey}`;
    if (subject.toolClass === "read-only") return null;
    return `fp:${subject.task ?? "-"}:${subject.tool}:${subject.clientArgsHash}`;
  }

  remember(key: string, receipt: string, result: unknown, now = Date.now()): void {
    this.entries.set(key, { receipt, result, at: now });
    if (this.entries.size > 1000) this.prune(now);
  }

  lookup(key: string, now = Date.now()): Remembered | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit;
  }

  /** Reserve a key while its first call is in flight; returns the existing reservation if one is already there. */
  reserve(key: string): Reservation {
    const existing = this.inflight.get(key);
    if (existing) return { existing };
    let settle: (r: Remembered | null) => void = () => {};
    const p = new Promise<Remembered | null>((resolve) => {
      settle = resolve;
    });
    this.inflight.set(key, p);
    return {
      settle: (r) => {
        this.inflight.delete(key);
        settle(r);
      },
    };
  }

  prune(now = Date.now()): void {
    for (const [k, v] of this.entries) if (now - v.at > this.windowMs) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}
