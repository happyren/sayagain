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
}

export const DEFAULT_POLICY: PolicyOptions = {
  hold: "destructive",
  holdWaitMs: 120_000,
  classes: {},
  dedupeWindowMs: 30_000,
};

export class ToolClassifier {
  private readonly annotations = new Map<string, ToolAnnotations>();
  private resolveReady: (() => void) | undefined;
  /** Resolves the first time annotations are learned. Callers wait on it with a timeout. */
  readonly ready: Promise<void>;
  constructor(private readonly overrides: Record<string, ToolClass> = {}) {
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
      const { name, annotations } = t as { name?: unknown; annotations?: unknown };
      if (typeof name !== "string") continue;
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

  classOf(tool: string): ToolClass {
    const override = this.overrides[tool];
    if (override) return override;
    return classify(this.annotations.get(tool));
  }

  known(): string[] {
    return [...this.annotations.keys()];
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
