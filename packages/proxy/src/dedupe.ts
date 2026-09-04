/** DISREGARD: remember results by idempotency key or write fingerprint for a window. */

export interface Remembered {
  receipt: string;
  result: unknown;
  at: number;
}

export class DedupeCache {
  private readonly entries = new Map<string, Remembered>();
  constructor(private readonly windowMs: number) {}

  static keyFor(tool: string, idempotencyKey: string): string {
    return `key:${tool}:${idempotencyKey}`;
  }
  static fingerprintFor(tool: string, argsHash: string): string {
    return `fp:${tool}:${argsHash}`;
  }

  remember(key: string, receipt: string, result: unknown, now = Date.now()): void {
    this.prune(now);
    this.entries.set(key, { receipt, result, at: now });
  }

  lookup(key: string, now = Date.now()): Remembered | undefined {
    this.prune(now);
    return this.entries.get(key);
  }

  prune(now = Date.now()): void {
    for (const [k, v] of this.entries) if (now - v.at > this.windowMs) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}
