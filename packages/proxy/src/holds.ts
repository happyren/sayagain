/** STANDBY: calls waiting for a person or a policy. In-process for wrap; the daemon (0.4) persists them. */
import { EventEmitter } from "node:events";
import type { ToolClass } from "@sayagain/sdk";

export type Decision = "approve" | "reject";

export interface Hold {
  receipt: string;
  tool: string;
  toolClass: ToolClass;
  reason: string;
  /** Arguments as sent; shown to the operator, never exported. */
  arguments: unknown;
  intent?: string;
  createdAt: number;
  expiresAt: number;
  decision?: Decision;
  decidedAt?: number;
  /** Which upstream the call was headed for, and why it is waiting. */
  /** The upstream's reported name, for display. */
  upstream?: string;
  /** The registry name of the boundary that holds it, for routing. */
  server?: string;
  /** Reloaded from storage after a restart: no host is waiting for the result. */
  orphaned?: boolean;
  mode?: string;
  /** The A/B arm the call ran in, so a hold resumed after a restart keeps it (docs/measurement.md 5.4). */
  arm?: "control" | "treatment";
}

export class HoldQueue extends EventEmitter {
  private readonly holds = new Map<string, Hold>();

  create(hold: Hold): Hold {
    this.holds.set(hold.receipt, hold);
    this.emit("created", hold);
    return hold;
  }

  list(): Hold[] {
    return [...this.holds.values()].filter((h) => h.decision === undefined);
  }

  get(receipt: string): Hold | undefined {
    return this.holds.get(receipt);
  }

  /** Records a decision. Returns false when the receipt is unknown or already decided. */
  decide(receipt: string, decision: Decision, now = Date.now()): boolean {
    const hold = this.holds.get(receipt);
    if (!hold || hold.decision !== undefined) return false;
    hold.decision = decision;
    hold.decidedAt = now;
    this.emit(`decided:${receipt}`, decision);
    this.emit("decided", hold);
    return true;
  }

  /** Resolves with the decision, or undefined when the wait elapses first. The hold stays open after a timeout. */
  waitFor(receipt: string, waitMs: number): Promise<Decision | undefined> {
    const hold = this.holds.get(receipt);
    if (!hold) return Promise.resolve(undefined);
    if (hold.decision !== undefined) return Promise.resolve(hold.decision);
    return new Promise((resolve) => {
      const event = `decided:${receipt}`;
      const timer = setTimeout(() => {
        this.off(event, onDecided);
        resolve(undefined);
      }, waitMs);
      const onDecided = (d: Decision) => {
        clearTimeout(timer);
        resolve(d);
      };
      this.once(event, onDecided);
    });
  }

  forget(receipt: string): void {
    this.holds.delete(receipt);
  }
}
