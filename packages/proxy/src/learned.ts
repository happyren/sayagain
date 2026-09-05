/**
 * The learning loop (ADR-0007): interventions derived from this deployment's
 * own ledger, applied by the boundary, measured, and reverted when they do
 * not help. Two kinds:
 *
 * - `coerce`: a signature's usual shape change was a type conversion, so the
 *   boundary applies that conversion to matching arguments before a safe
 *   call leaves, and offers it as a repair after a failure on any tool.
 * - `hint`: a fact backed by a recovery path or shape change, appended to
 *   the tool's description in `tools/list` and to the error the model sees
 *   when the same signature recurs.
 *
 * Nothing here reads argument values: shapes, signatures and tool names only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  finalRows,
  recoveries,
  type SignatureStats,
  selectRows,
  signatureStats,
} from "./analysis.js";
import { homePath } from "./home.js";
import type { LedgerRow } from "./ledger.js";
import type { RepairChange } from "./repair.js";

export type CoercionRule =
  | "string-to-number"
  | "string-to-boolean"
  | "array-to-comma-string"
  | "number-to-string"
  | "scalar-to-array";

export interface Lift {
  calls: number;
  failures: number;
  failureRatePct: number;
  medianCallsToRecover: number;
}

export interface Intervention {
  id: string;
  kind: "coerce" | "hint";
  server: string;
  tool: string;
  /** The masked signature the evidence came from. */
  signature: string;
  errorClass: string;
  /** coerce: the argument and the conversion. */
  path?: string;
  from?: string;
  to?: string;
  rule?: CoercionRule;
  /** hint: the sentence appended to the description, and the one appended to the error. */
  fact?: string;
  errorHint?: string;
  evidence: number;
  learnedAt: string;
  activatedAt: string;
  state: "active" | "disabled" | "reverted";
  reason?: string;
  before?: Lift;
  after?: Lift;
}

export interface LearnedFile {
  version: 1;
  updatedAt: string;
  interventions: Intervention[];
}

export const defaultLearnedPath = (): string => homePath("learned.json");

/** Facts appended to a tool description are delimited and attributed, and capped in length. */
export const AUGMENT_PREFIX = "[Say Again learned]";
export const AUGMENT_CAP = 200;

const CONVERSIONS: Record<string, CoercionRule> = {
  "string->number": "string-to-number",
  "string->boolean": "string-to-boolean",
  "array->string": "array-to-comma-string",
  "number->string": "number-to-string",
  "string->array": "scalar-to-array",
  "number->array": "scalar-to-array",
};

const typeOf = (v: unknown): string =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

/** Apply one conversion to a value, or return undefined when it does not apply. */
export function convert(value: unknown, rule: CoercionRule): unknown {
  switch (rule) {
    case "string-to-number":
      return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : undefined;
    case "string-to-boolean":
      return typeof value === "string" && /^(true|false)$/i.test(value.trim())
        ? value.trim().toLowerCase() === "true"
        : undefined;
    case "array-to-comma-string":
      return Array.isArray(value) &&
        value.every((x) => ["string", "number", "boolean"].includes(typeof x))
        ? value.join(",")
        : undefined;
    case "number-to-string":
      return typeof value === "number" ? String(value) : undefined;
    case "scalar-to-array":
      return ["string", "number", "boolean"].includes(typeof value) ? [value] : undefined;
    default:
      return undefined;
  }
}

/** Apply active coercions to arguments. Returns null when none applied. */
export function applyLearnedCoercions(
  args: unknown,
  rules: Intervention[],
): { arguments: Record<string, unknown>; changes: RepairChange[] } | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  const changes: RepairChange[] = [];
  for (const r of rules) {
    if (r.kind !== "coerce" || r.state !== "active" || !r.path || !r.rule || !r.from) continue;
    const key = r.path.replace(/^\//, "");
    if (!Object.hasOwn(out, key)) continue;
    const value = out[key];
    if (typeOf(value) !== r.from) continue;
    const next = convert(value, r.rule);
    if (next === undefined) continue;
    changes.push({ path: r.path, rule: `learned:${r.id}`, from: value, to: next });
    out[key] = next;
  }
  return changes.length ? { arguments: out, changes } : null;
}

/** The description a client sees: the upstream's own text, then the learned block. */
export function augmentDescription(description: unknown, facts: string[]): string | undefined {
  const base = typeof description === "string" ? description.trimEnd() : "";
  if (!facts.length) return typeof description === "string" ? description : undefined;
  let block = "";
  for (const f of facts) {
    const next = block ? `${block} ${f}` : f;
    if (next.length > AUGMENT_CAP) break;
    block = next;
  }
  if (!block) return typeof description === "string" ? description : undefined;
  return base ? `${base}\n\n${AUGMENT_PREFIX} ${block}` : `${AUGMENT_PREFIX} ${block}`;
}

const slug = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
const short = (s: string): string => {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
};

/** Interventions the evidence supports, whether or not they already exist. */
export function deriveInterventions(
  rows: LedgerRow[],
  opts: { minEvidence?: number; now?: Date } = {},
): Intervention[] {
  const minEvidence = opts.minEvidence ?? 3;
  const now = (opts.now ?? new Date()).toISOString();
  const out: Intervention[] = [];
  for (const s of signatureStats(rows)) {
    if (s.count < minEvidence) continue;
    const base = {
      server: s.server,
      tool: s.tool,
      signature: s.signature,
      errorClass: s.errorClass,
      evidence: s.count,
      learnedAt: now,
      activatedAt: now,
      state: "active" as const,
    };
    const changed = s.topShapeChange?.match(/changed ([^;]+)/)?.[1] ?? "";
    for (const part of changed
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      const m = part.match(/^([^:]+):([a-z]+)->([a-z]+)$/);
      const [, name, fromType, toType] = m ?? [];
      if (!name || !fromType || !toType) continue;
      const rule = CONVERSIONS[`${fromType}->${toType}`];
      if (!rule || s.errorClass !== "coercible") continue;
      const path = `/${name}`;
      const id = `coerce:${slug(s.server)}/${slug(s.tool)}${path}:${fromType}-${toType}`;
      const fact = `\`${name}\` is a ${toType}, not a ${fromType}.`;
      out.push({
        ...base,
        id,
        kind: "coerce",
        path,
        from: fromType,
        to: toType,
        rule,
        fact,
        errorHint: `Say Again: last time this failed it was fixed by passing \`${name}\` as a ${toType} instead of a ${fromType}.`,
      });
    }
    if (s.errorClass === "semantic" && s.topRecoveryPath && s.topRecoveryPath !== "(retry only)") {
      const first = s.topRecoveryPath.split(" > ")[0]?.trim();
      if (first && first !== s.tool) {
        const id = `hint:${slug(s.server)}/${slug(s.tool)}:precondition:${short(s.signature)}`;
        out.push({
          ...base,
          id,
          kind: "hint",
          fact: `Call \`${first}\` first; \`${s.tool}\` fails with "${s.signature.slice(0, 60)}" otherwise.`,
          errorHint: `Say Again: last time this was fixed by calling \`${first}\` first.`,
        });
      }
    }
  }
  return out;
}

const medianCalls = (recs: { calls: number }[]): number => {
  if (!recs.length) return 0;
  const xs = recs.map((r) => r.calls).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? 0;
};

function liftOver(rows: LedgerRow[], i: Intervention, since: Date | undefined, until: Date): Lift {
  const scoped = selectRows(rows, { until }).filter(
    (r) => r.tool === i.tool && (r.upstream === i.server || r.server === i.server),
  );
  const finals = finalRows(scoped).filter(
    (r) =>
      r.status !== "deduplicated" &&
      r.status !== "held" &&
      (since === undefined || Date.parse(r.ts) >= since.getTime()),
  );
  const failures = finals.filter((r) => r.isError);
  const recs = recoveries(scoped, since ? { since } : {}).filter((x) => x.row.tool === i.tool);
  return {
    calls: finals.length,
    failures: failures.length,
    failureRatePct: finals.length ? +((100 * failures.length) / finals.length).toFixed(1) : 0,
    medianCallsToRecover: medianCalls(recs),
  };
}

/** The tool's numbers before and after the intervention was activated. */
export function measureLift(
  rows: LedgerRow[],
  i: Intervention,
  now: Date = new Date(),
): { before: Lift; after: Lift } {
  const at = new Date(i.activatedAt);
  return { before: liftOver(rows, i, undefined, at), after: liftOver(rows, i, at, now) };
}

/** Calls after activation before the loop judges an intervention. */
export const REVERT_MIN_CALLS = 20;

export class LearnedStore {
  private file: LearnedFile = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    interventions: [],
  };
  constructor(readonly path: string = defaultLearnedPath()) {
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LearnedFile;
      if (parsed && Array.isArray(parsed.interventions)) this.file = parsed;
    } catch {
      // a torn file is not a reason to crash the daemon; the next update rewrites it
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.file.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get updatedAt(): string {
    return this.file.updatedAt;
  }

  list(): Intervention[] {
    return [...this.file.interventions];
  }

  get(id: string): Intervention | undefined {
    return this.file.interventions.find((i) => i.id === id);
  }

  private matches(i: Intervention, server: string, tool: string): boolean {
    return (
      i.state === "active" &&
      i.tool === tool &&
      (i.server === server || i.server === serverAlias(server))
    );
  }

  /** Active coercions for a tool. `server` may be the registry name or the upstream's own. */
  coercionsFor(server: string, tool: string, upstream?: string): Intervention[] {
    return this.file.interventions.filter(
      (i) =>
        i.kind === "coerce" &&
        (this.matches(i, server, tool) ||
          (upstream !== undefined && this.matches(i, upstream, tool))),
    );
  }

  /** Facts to append to a tool's description. */
  factsFor(server: string, tool: string, upstream?: string): string[] {
    return this.file.interventions
      .filter(
        (i) =>
          i.fact &&
          (this.matches(i, server, tool) ||
            (upstream !== undefined && this.matches(i, upstream, tool))),
      )
      .map((i) => i.fact as string);
  }

  /** The sentence to append to an error whose signature the loop has seen fixed before. */
  hintFor(server: string, tool: string, signature: string, upstream?: string): string | undefined {
    return this.file.interventions.find(
      (i) =>
        i.errorHint &&
        i.signature === signature &&
        (this.matches(i, server, tool) ||
          (upstream !== undefined && this.matches(i, upstream, tool))),
    )?.errorHint;
  }

  setState(id: string, state: Intervention["state"], reason?: string): boolean {
    const i = this.get(id);
    if (!i) return false;
    i.state = state;
    if (reason !== undefined) i.reason = reason;
    else delete i.reason;
    if (state === "active") i.activatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Bring the store up to date with the ledger: learn what the evidence now supports, measure
   * every intervention, and revert the ones that had their chance and did not help.
   */
  reconcile(
    rows: LedgerRow[],
    opts: { minEvidence?: number; now?: Date } = {},
  ): { added: Intervention[]; reverted: Intervention[] } {
    const now = opts.now ?? new Date();
    const added: Intervention[] = [];
    const reverted: Intervention[] = [];
    for (const candidate of deriveInterventions(rows, { ...opts, now })) {
      const existing = this.get(candidate.id);
      if (existing) {
        existing.evidence = candidate.evidence;
        continue;
      }
      this.file.interventions.push(candidate);
      added.push(candidate);
    }
    for (const i of this.file.interventions) {
      const { before, after } = measureLift(rows, i, now);
      i.before = before;
      i.after = after;
      if (
        i.state === "active" &&
        after.calls >= REVERT_MIN_CALLS &&
        after.failureRatePct >= before.failureRatePct &&
        before.calls > 0
      ) {
        i.state = "reverted";
        i.reason = `no lift after ${after.calls} calls: failure rate ${before.failureRatePct}% before, ${after.failureRatePct}% after`;
        reverted.push(i);
      }
    }
    return { added, reverted };
  }
}

/** Registry names and upstream names are both accepted; nothing to alias for now. */
const serverAlias = (server: string): string => server;

/** A tool definition report for the upstream's maintainers, in the issue template's shape. */
export function upstreamReport(
  server: string,
  rows: LedgerRow[],
  store: LearnedStore,
  minOccurrences = 10,
): string {
  const sigs = signatureStats(rows).filter(
    (s) =>
      (s.server === server || rows.some((r) => r.server === server && r.upstream === s.server)) &&
      s.count >= minOccurrences &&
      (s.topRecoveryPath || s.topShapeChange),
  );
  const lines = [
    `# Tool definition report: ${server}`,
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by Say Again from ${rows.length} ledger rows. No argument values, results or prompts are included; error messages are masked.`,
    "",
  ];
  if (!sigs.length) lines.push("No signature reached the threshold yet.");
  for (const s of sigs) {
    lines.push(
      `## ${s.tool}: ${s.signature}`,
      "",
      `- Occurrences: ${s.count} (${s.errorClass}); median ${s.medianCallsToRecover} calls to recover; ${s.unrecovered} never recovered.`,
    );
    if (s.topShapeChange)
      lines.push(`- What fixed it: the arguments changed (${s.topShapeChange}).`);
    if (s.topRecoveryPath) lines.push(`- Recovery path: ${s.topRecoveryPath}.`);
    const applied = store.list().filter((i) => i.tool === s.tool && i.signature === s.signature);
    for (const i of applied)
      lines.push(
        `- Say Again ${i.state === "active" ? "applies" : `tried (${i.state})`}: ${i.kind === "coerce" ? `${i.rule} on ${i.path}` : i.fact}${i.after ? `; failure rate ${i.before?.failureRatePct ?? "?"}% before, ${i.after.failureRatePct}% after (${i.after.calls} calls)` : ""}.`,
      );
    lines.push(`- Suggestion: ${s.suggestion}`, "");
  }
  return `${lines.join("\n")}\n`;
}

export type { SignatureStats };
