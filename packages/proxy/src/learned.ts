/**
 * The learning loop (ADR-0007): interventions derived from this deployment's
 * own ledger, applied by the boundary, measured, and reverted when they do
 * not help. Two kinds:
 *
 * - `coerce`: a signature's usual shape change was a type conversion, so the
 *   boundary offers that conversion as a repair after a failure on any tool
 *   (a write then waits behind a hold, as every repair does). Once an
 *   operator switches the intervention to `apply`, the conversion also runs
 *   before a read-only call leaves; by default it only advises (ADR-0009).
 * - `hint`: a not-found failure whose usual recovery began with another
 *   tool, appended as a sentence to the tool's description in `tools/list`
 *   and to the error the model sees when the same signature recurs.
 *
 * Nothing here reads argument values: shapes, signatures and tool names only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { finalRows, recoveries, selectRows, signatureStats } from "./analysis.js";
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
  /** Failures with one of the intervention's own signatures. */
  failures: number;
  failureRatePct: number;
  medianCallsToRecover: number;
}

export interface Intervention {
  id: string;
  kind: "coerce" | "hint";
  server: string;
  tool: string;
  /** The masked signatures the evidence came from; the first is the one the loop saw first. */
  signature: string;
  signatures: string[];
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
  /**
   * advise (default): the hint in the description and the repair after a failure. apply: also
   * before a read-only call leaves, which only an operator can turn on (ADR-0009).
   */
  mode?: "advise" | "apply";
  reason?: string;
  before?: Lift;
  after?: Lift;
}

export interface LearnedFile {
  version: 1;
  updatedAt: string;
  /** Occurrences a pattern needs before it becomes an intervention. Default 3. */
  minEvidence?: number;
  interventions: Intervention[];
}

export const defaultLearnedPath = (): string => homePath("learned.json");

/** Facts appended to a tool description are delimited and attributed, and capped in length, prefix included. */
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

const NOT_FOUND = /not found|no such|does not exist/i;

const typeOf = (v: unknown): string =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
const article = (type: string): string => (/^[aeiou]/i.test(type) ? `an ${type}` : `a ${type}`);

/** Apply one conversion to a value, or return undefined when it does not apply or would change its meaning. */
export function convert(value: unknown, rule: CoercionRule): unknown {
  switch (rule) {
    case "string-to-number": {
      if (typeof value !== "string") return undefined;
      const s = value.trim();
      // No leading zeros, no exponents, and the number must print back as the same text: "007", "1e3"
      // and "12345678901234567890" are identifiers or lossy, not numbers to coerce.
      if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return undefined;
      const n = Number(s);
      return String(n) === s && (Number.isInteger(n) ? Number.isSafeInteger(n) : true)
        ? n
        : undefined;
    }
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
    changes.push({ path: r.path, rule: `learned:${r.rule}`, via: r.id, from: value, to: next });
    out[key] = next;
  }
  return changes.length ? { arguments: out, changes } : null;
}

/** The description a client sees: the upstream's own text, then the learned block, capped as a whole. */
export function augmentDescription(description: unknown, facts: string[]): string | undefined {
  const base = typeof description === "string" ? description.trimEnd() : "";
  const original = typeof description === "string" ? description : undefined;
  if (!facts.length) return original;
  const room = AUGMENT_CAP - AUGMENT_PREFIX.length - 1;
  let block = "";
  for (const f of facts) {
    const next = block ? `${block} ${f}` : f;
    if (next.length > room) continue; // this fact does not fit; a shorter one still may
    block = next;
  }
  if (!block) return original;
  return base ? `${base}\n\n${AUGMENT_PREFIX} ${block}` : `${AUGMENT_PREFIX} ${block}`;
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  const byId = new Map<string, Intervention>();
  const add = (i: Intervention) => {
    const existing = byId.get(i.id);
    if (!existing) byId.set(i.id, i);
    else {
      existing.evidence += i.evidence;
      for (const s of i.signatures)
        if (!existing.signatures.includes(s)) existing.signatures.push(s);
    }
  };
  for (const s of signatureStats(rows)) {
    const base = {
      server: s.server,
      tool: s.tool,
      signature: s.signature,
      signatures: [s.signature],
      errorClass: s.errorClass,
      learnedAt: now,
      activatedAt: now,
      state: "active" as const,
    };
    // A type change is evidence only when it was the whole fix: a diff that also added or removed a
    // key says the model changed more than a type.
    const diff = s.topShapeChange ?? "";
    if (
      s.errorClass === "coercible" &&
      s.topShapeChangeCount >= minEvidence &&
      /^changed /.test(diff)
    ) {
      for (const part of diff
        .slice("changed ".length)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        const m = part.match(/^([^:]+):([a-z]+)->([a-z]+)$/);
        const [, name, fromType, toType] = m ?? [];
        if (!name || !fromType || !toType) continue;
        const rule = CONVERSIONS[`${fromType}->${toType}`];
        if (!rule) continue;
        const path = `/${name}`;
        add({
          ...base,
          id: `coerce:${slug(s.server)}/${slug(s.tool)}${path}:${fromType}-${toType}`,
          kind: "coerce",
          mode: "advise", // applying before a call leaves is the operator's switch (ADR-0009)
          path,
          from: fromType,
          to: toType,
          rule,
          fact: `\`${name}\` is ${article(toType)}, not ${article(fromType)}.`,
          errorHint: `Say Again: last time this failed it was fixed by passing \`${name}\` as ${article(toType)} instead of ${article(fromType)}.`,
          evidence: s.topShapeChangeCount,
        });
      }
    }
    // A precondition is evidence only for not-found failures whose recovery started elsewhere.
    if (
      s.errorClass === "semantic" &&
      NOT_FOUND.test(s.signature) &&
      s.topRecoveryPath &&
      s.topRecoveryPath !== "(retry only)" &&
      s.topRecoveryPathCount >= minEvidence
    ) {
      const first = s.topRecoveryPath.split(" > ")[0]?.trim();
      if (first && first !== s.tool)
        add({
          ...base,
          id: `hint:${slug(s.server)}/${slug(s.tool)}:first-${slug(first)}:${short(s.signature)}`,
          kind: "hint",
          fact: `Call \`${first}\` first; \`${s.tool}\` fails with a not-found error otherwise.`,
          errorHint: `Say Again: last time this was fixed by calling \`${first}\` first.`,
          evidence: s.topRecoveryPathCount,
        });
    }
  }
  return [...byId.values()];
}

const medianCalls = (recs: { calls: number }[]): number => {
  if (!recs.length) return 0;
  const xs = recs.map((r) => r.calls).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? 0;
};

/**
 * The tool's numbers over [since, until): calls, failures with the intervention's own signatures,
 * their rate, and the median calls to recover. Recovery windows run over the whole history, so a
 * failure just before a boundary is not cut short.
 */
function liftOver(rows: LedgerRow[], i: Intervention, since: Date | undefined, until: Date): Lift {
  const scoped = rows.filter(
    (r) => r.tool === i.tool && (r.upstream === i.server || r.server === i.server),
  );
  const inSpan = (r: LedgerRow) =>
    Date.parse(r.ts) < until.getTime() &&
    (since === undefined || Date.parse(r.ts) >= since.getTime());
  const finals = finalRows(selectRows(scoped)).filter(
    (r) => r.status !== "deduplicated" && r.status !== "held" && inSpan(r),
  );
  const failures = finals.filter((r) => r.isError && i.signatures.includes(r.errorSignature ?? ""));
  const recs = recoveries(selectRows(scoped)).filter(
    (x) => inSpan(x.row) && i.signatures.includes(x.row.errorSignature ?? ""),
  );
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

const isIntervention = (x: unknown): x is Intervention => {
  if (typeof x !== "object" || x === null) return false;
  const i = x as Record<string, unknown>;
  return (
    typeof i.id === "string" &&
    (i.kind === "coerce" || i.kind === "hint") &&
    typeof i.server === "string" &&
    typeof i.tool === "string" &&
    typeof i.signature === "string" &&
    ["active", "disabled", "reverted"].includes(String(i.state))
  );
};

export class LearnedStore {
  private file: LearnedFile = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    interventions: [],
  };
  private loadedMtime = 0;
  private checkedAt = 0;
  constructor(readonly path: string = defaultLearnedPath()) {
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LearnedFile>;
      if (parsed && Array.isArray(parsed.interventions)) {
        const interventions = parsed.interventions.filter(isIntervention).map((i) => ({
          ...i,
          signatures:
            Array.isArray(i.signatures) && i.signatures.length ? i.signatures : [i.signature],
          // Only an explicit "apply" changes a call before it leaves; anything else advises.
          ...(i.kind === "coerce"
            ? { mode: (i.mode === "apply" ? "apply" : "advise") as "apply" | "advise" }
            : {}),
        }));
        this.file = {
          version: 1,
          updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
          ...(parsed.minEvidence !== undefined ? { minEvidence: parsed.minEvidence } : {}),
          interventions,
        };
      }
      this.loadedMtime = statSync(this.path).mtimeMs;
    } catch {
      // a torn file is not a reason to crash the daemon; the next update rewrites it
    }
  }

  /** Re-read the file when another process (the CLI, another daemon) changed it. Cheap: one stat, at most every few seconds. */
  maybeReload(minIntervalMs = 5000): void {
    const now = Date.now();
    if (now - this.checkedAt < minIntervalMs) return;
    this.checkedAt = now;
    try {
      if (existsSync(this.path) && statSync(this.path).mtimeMs !== this.loadedMtime) this.load();
    } catch {
      // unreadable right now; keep what we have
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.file.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      this.loadedMtime = statSync(this.path).mtimeMs;
    } catch {
      // fine
    }
  }

  get updatedAt(): string {
    return this.file.updatedAt;
  }

  get minEvidence(): number {
    return this.file.minEvidence ?? 3;
  }

  list(): Intervention[] {
    return [...this.file.interventions];
  }

  get(id: string): Intervention | undefined {
    return this.file.interventions.find((i) => i.id === id);
  }

  private matches(i: Intervention, server: string, tool: string, upstream?: string): boolean {
    return (
      i.state === "active" &&
      i.tool === tool &&
      (i.server === server || (upstream !== undefined && i.server === upstream))
    );
  }

  /**
   * Active coercions for a tool. `server` is the registry name; `upstream` the server's own name.
   * With `applyOnly`, only the ones an operator switched to apply before a call leaves.
   */
  coercionsFor(server: string, tool: string, upstream?: string, applyOnly = false): Intervention[] {
    return this.file.interventions.filter(
      (i) =>
        i.kind === "coerce" &&
        this.matches(i, server, tool, upstream) &&
        (!applyOnly || i.mode === "apply"),
    );
  }

  /** The operator's switch between advising and applying before a call leaves (coercions only). */
  setMode(id: string, mode: "advise" | "apply"): boolean {
    const i = this.get(id);
    if (i?.kind !== "coerce") return false;
    i.mode = mode;
    return true;
  }

  /** Facts to append to a tool's description. */
  factsFor(server: string, tool: string, upstream?: string): string[] {
    return this.file.interventions
      .filter((i) => i.fact && this.matches(i, server, tool, upstream))
      .map((i) => i.fact as string);
  }

  /** The sentence to append to an error whose signature the loop has seen fixed before, unless that fix was already applied to the call. */
  hintFor(
    server: string,
    tool: string,
    signature: string,
    upstream?: string,
    applied: string[] = [],
  ): string | undefined {
    return this.file.interventions.find(
      (i) =>
        i.errorHint &&
        i.signatures.includes(signature) &&
        !applied.includes(i.id) &&
        this.matches(i, server, tool, upstream),
    )?.errorHint;
  }

  /** Operator switch. Disabling keeps the automatic verdict in the reason, so the audit trail survives. */
  setState(id: string, state: Intervention["state"], reason?: string): boolean {
    const i = this.get(id);
    if (!i) return false;
    const earlier = i.state === "reverted" && i.reason ? `; earlier: ${i.reason}` : "";
    i.state = state;
    if (reason !== undefined) i.reason = `${reason}${earlier}`;
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
    this.maybeReload(0);
    if (opts.minEvidence !== undefined) this.file.minEvidence = opts.minEvidence;
    const now = opts.now ?? new Date();
    const added: Intervention[] = [];
    const reverted: Intervention[] = [];
    for (const candidate of deriveInterventions(rows, { minEvidence: this.minEvidence, now })) {
      const existing = this.get(candidate.id);
      if (existing) {
        existing.evidence = candidate.evidence;
        for (const s of candidate.signatures)
          if (!existing.signatures.includes(s)) existing.signatures.push(s);
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
        before.calls > 0 &&
        after.failureRatePct >= before.failureRatePct
      ) {
        i.state = "reverted";
        i.reason = `no lift after ${after.calls} calls: this failure was ${before.failureRatePct}% of calls before, ${after.failureRatePct}% after`;
        reverted.push(i);
      }
    }
    return { added, reverted };
  }
}

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
      lines.push(
        `- What fixed it: the arguments changed (${s.topShapeChange}), ${s.topShapeChangeCount} time(s).`,
      );
    if (s.topRecoveryPath)
      lines.push(`- Recovery path: ${s.topRecoveryPath}, ${s.topRecoveryPathCount} time(s).`);
    for (const i of store
      .list()
      .filter((x) => x.tool === s.tool && x.signatures.includes(s.signature)))
      lines.push(
        `- Say Again ${i.state === "active" ? "applies" : `tried (${i.state})`}: ${i.kind === "coerce" ? `${i.rule} on ${i.path}` : i.fact}${i.after ? `; this failure was ${i.before?.failureRatePct ?? "?"}% of calls before, ${i.after.failureRatePct}% after (${i.after.calls} calls)` : ""}.`,
      );
    lines.push(`- Suggestion: ${s.suggestion}`, "");
  }
  return `${lines.join("\n")}\n`;
}
