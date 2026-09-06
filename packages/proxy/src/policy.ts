/** Tool classification and the hold policy (ADR-0004). */
import { classify, type ToolAnnotations, type ToolClass } from "@sayagain/sdk";

export type HoldMode = "destructive" | "always" | "never";

export interface PolicyOptions {
  /** Which calls are held before leaving. Default: destructive tools only. */
  hold: HoldMode;
  /** How long a held call waits for a decision before the agent is told it is held. */
  holdWaitMs: number;
  /** Operator overrides: tool name to class. Win over annotations. */
  classes: Record<string, ToolClass>;
  /** Retention for idempotency keys and write fingerprints. */
  dedupeWindowMs: number;
  /** Attempts for retryable failures on read-only and idempotent tools (1 = no retry). */
  retryAttempts: number;
  /** First backoff; doubles per attempt. */
  retryBaseMs: number;
  /** Deterministic argument repair from inputSchema on coercible failures. */
  repair: boolean;
  /** Repairs allowed per task before dead-lettering. */
  repairsPerTask: number;
  /** When no task id is supplied, the repair budget is per window of this length (spec 3.3 fallback). */
  repairWindowMs: number;
  /** Append one actionable sentence to final failures. */
  rewriteErrors: boolean;
}

export const DEFAULT_POLICY: PolicyOptions = {
  hold: "destructive",
  holdWaitMs: 120_000,
  classes: {},
  dedupeWindowMs: 30_000,
  retryAttempts: 3,
  retryBaseMs: 250,
  repair: true,
  repairsPerTask: 3,
  repairWindowMs: 600_000,
  rewriteErrors: true,
};

export class ToolClassifier {
  private readonly annotations = new Map<string, ToolAnnotations>();
  private readonly schemas = new Map<string, unknown>();
  private resolveReady: (() => void) | undefined;
  /** Resolves the first time annotations are learned. Callers wait on it with a timeout. */
  readonly ready: Promise<void>;
  private overrides: Record<string, ToolClass>;
  constructor(overrides: Record<string, ToolClass> = {}) {
    this.overrides = { ...overrides };
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Learn annotations from a tools/list result. */
  learn(tools: unknown): number {
    if (!Array.isArray(tools)) return 0;
    let n = 0;
    for (const t of tools) {
      if (typeof t !== "object" || t === null) continue;
      const { name, annotations, inputSchema } = t as {
        name?: unknown;
        annotations?: unknown;
        inputSchema?: unknown;
      };
      if (typeof name !== "string") continue;
      if (inputSchema !== undefined) this.schemas.set(name, inputSchema);
      this.annotations.set(
        name,
        typeof annotations === "object" && annotations !== null
          ? (annotations as ToolAnnotations)
          : {},
      );
      n++;
    }
    if (this.resolveReady) {
      this.resolveReady();
      this.resolveReady = undefined;
    }
    return n;
  }

  get warm(): boolean {
    return this.resolveReady === undefined;
  }

  /** Forget what was learned (the upstream restarted and may serve different tools); `ready` resets too. */
  reset(): void {
    this.annotations.clear();
    this.schemas.clear();
    if (this.resolveReady === undefined)
      (this as { ready: Promise<void> }).ready = new Promise((resolve) => {
        this.resolveReady = resolve;
      });
  }

  /** The probe answered without tools (error or empty): stop waiting, there is nothing to learn yet. */
  markProbed(): void {
    if (this.resolveReady) {
      this.resolveReady();
      this.resolveReady = undefined;
    }
  }

  /** Replace the operator's table; classes are pure policy, so this needs no restart. */
  setOverrides(overrides: Record<string, ToolClass>): void {
    this.overrides = { ...overrides }; // the caller keeps its object; the classifier keeps its own
  }

  /** Where a tool's class comes from, for `sayagain classes`. */
  sourceOf(tool: string): "override" | "annotation" | "fallback" {
    if (this.overrides[tool]) return "override";
    const a = this.annotations.get(tool);
    return a &&
      (a.readOnlyHint !== undefined ||
        a.destructiveHint !== undefined ||
        a.idempotentHint !== undefined)
      ? "annotation"
      : "fallback";
  }

  annotationsOf(tool: string): ToolAnnotations | undefined {
    return this.annotations.get(tool);
  }

  classOf(tool: string): ToolClass {
    const override = this.overrides[tool];
    if (override) return override;
    return classify(this.annotations.get(tool));
  }

  known(): string[] {
    return [...this.annotations.keys()];
  }

  schemaOf(tool: string): unknown {
    return this.schemas.get(tool);
  }
}

export function shouldHold(toolClass: ToolClass, mode: HoldMode): boolean {
  if (mode === "never") return false;
  if (mode === "always") return toolClass !== "read-only";
  return toolClass === "destructive";
}

export function parseClassOverrides(entries: string[]): Record<string, ToolClass> {
  const out: Record<string, ToolClass> = {};
  for (const e of entries) {
    const eq = e.indexOf("=");
    if (eq <= 0) throw new Error(`--class expects tool=class, got ${e}`);
    const tool = e.slice(0, eq);
    const cls = e.slice(eq + 1);
    if (
      cls !== "read-only" &&
      cls !== "idempotent-write" &&
      cls !== "write" &&
      cls !== "destructive"
    )
      throw new Error(`unknown class ${cls} for ${tool}`);
    out[tool] = cls;
  }
  return out;
}
