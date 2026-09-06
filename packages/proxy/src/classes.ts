/**
 * What class each tool gets, where that class came from, and what to do when the server's own
 * annotations are missing or wrong (ADR-0012).
 *
 * The boundary's whole behaviour hangs off the class: a read-only call is retried and may be
 * coerced before it leaves, a destructive one is held. A server that declares nothing leaves every
 * tool in the cautious fallback, and a server that declares badly can put a screenshot behind an
 * approval. Neither is visible from the outside, so this module names the class, its source, and a
 * suggestion the operator can read before writing it down.
 *
 * Suggestions run in two directions and they are not equally safe. Raising a class makes every call
 * to that tool wait for a decision. Lowering one to read-only removes the hold, allows a retry and
 * allows a pre-send coercion, so a mistake there is the failure the boundary exists to prevent.
 * Everything below is arranged around that asymmetry.
 */
import { classify, type ToolAnnotations, type ToolClass } from "@sayagain/sdk";

/** Which way a suggestion moves the class; the two directions carry different risk. */
export type Direction = "raise" | "lower";

/** One tool as the boundary sees it. */
export interface ToolClassRow {
  tool: string;
  toolClass: ToolClass;
  /** Where the class came from: the operator's table, the server's annotations, or the fallback. */
  source: "override" | "annotation" | "fallback";
  annotations: ToolAnnotations | undefined;
  /** What the boundary does with this class, in one clause. */
  effect: string;
  /** Set when the declaration contradicts itself, or the suggestion needs care. */
  warning?: string | undefined;
  /** A class worth considering instead, with the reason; never applied on its own. */
  suggestion?: { toolClass: ToolClass; direction: Direction; reason: string };
}

export interface ClassReport {
  server: string;
  rows: ToolClassRow[];
  counts: Record<ToolClass, number>;
  /** Tools the server annotates not at all: a fact about the server, override or no override. */
  undeclared: number;
  /** Tools actually left on the cautious fallback: undeclared and not overridden. */
  fallback: number;
  /** Suggestions, in tool order; empty when the server's own declarations are believable. */
  suggestions: ToolClassRow[];
}

/**
 * What the boundary does with a class, as the code does it: retry is for the two safe classes
 * (core.ts decideOnFailure), a retryable failure on the other two is held rather than retried, and
 * a read-only call still dedupes when the caller sends an idempotency key (dedupe.ts keyFor).
 */
const EFFECTS: Record<ToolClass, string> = {
  "read-only":
    "retried on a retryable failure; never held; deduplicated only on an idempotency key; a learned coercion may fix its arguments before it leaves",
  "idempotent-write":
    "retried on a retryable failure; deduplicated within the window; held before it leaves only under --hold always",
  write:
    "never retried: a retryable failure is held for a decision instead; deduplicated within the window; held before it leaves only under --hold always",
  destructive:
    "held for a decision before it leaves; never retried, and a retryable failure is held again",
};

/** Verbs that say a tool only reads, plainly enough to lower a class on their own. */
const READ_VERBS = [
  "get",
  "list",
  "search",
  "find",
  "read",
  "show",
  "describe",
  "fetch",
  "query",
  "status",
  "inspect",
  "view",
  "count",
  "lookup",
  "explore",
  "trace",
  "diff",
  "peek",
  "summarize",
  "summarise",
];
/**
 * Verbs that read in one sense and change something in another: check out, resolve a conflict,
 * verify and charge, validate and apply, preview a deploy. They never justify a lowering.
 */
const AMBIGUOUS_READ_VERBS = [
  "check",
  "resolve",
  "verify",
  "validate",
  "preview",
  "analyze",
  "analyse",
];
/** Verbs that say a tool changes something, and repeating it lands in the same place. */
const IDEMPOTENT_VERBS = ["set", "put", "upsert", "ensure", "open", "select", "focus"];
/** Verbs that say a tool changes something. */
const WRITE_VERBS = [
  "create",
  "add",
  "insert",
  "write",
  "update",
  "edit",
  "patch",
  "save",
  "post",
  "send",
  "publish",
  "apply",
  "run",
  "execute",
  "export",
  "upload",
  "import",
  "move",
  "rename",
  "copy",
  "append",
  "start",
  "stop",
  "restart",
  "enable",
  "disable",
  "assign",
  "merge",
  "replace",
  "acquire",
  "claim",
  "reserve",
  "lock",
];
/** Verbs whose destruction is unmistakable wherever they sit in the name. */
const DESTRUCTIVE_VERBS = [
  "delete",
  "destroy",
  "purge",
  "wipe",
  "truncate",
  "erase",
  "terminate",
  "revoke",
  "uninstall",
];
/**
 * Verbs that destroy when they lead and mean something else inside a phrase: a drop shadow, a kill
 * switch, removing a filter. Read only in the leading position.
 */
const LEADING_DESTRUCTIVE_VERBS = ["remove", "drop", "kill", "prune", "discard", "clear", "reset"];
/** A name that joins two acts describes both; the safe reading is the one that changes something. */
const CONJUNCTIONS = ["and", "then", "or", "plus", "with"];

const MUTATING = new Set([
  ...WRITE_VERBS,
  ...IDEMPOTENT_VERBS,
  ...DESTRUCTIVE_VERBS,
  ...LEADING_DESTRUCTIVE_VERBS,
]);

/** What a description's first sentence says the tool does to the world. */
const MUTATING_PROSE =
  /\b(creat|delet|remov|updat|modif|writ|chang|overwrit|replac|acquir|lock|insert|upsert|destroy|purg|renam|mov|revok|terminat|drop)/i;

const segments = (tool: string): string[] =>
  tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const firstSentence = (description: string | undefined): string => {
  if (!description) return "";
  const trimmed = description.trim().slice(0, 400);
  const stop = trimmed.search(/[.!?](\s|$)/);
  return stop === -1 ? trimmed : trimmed.slice(0, stop);
};

/** The class a tool's name suggests, or undefined when the name says nothing. */
export function classFromName(tool: string): { toolClass: ToolClass; verb: string } | undefined {
  const parts = segments(tool);
  const first = parts[0] ?? "";
  const leadsWithRead = READ_VERBS.includes(first) || AMBIGUOUS_READ_VERBS.includes(first);
  if (LEADING_DESTRUCTIVE_VERBS.includes(first)) return { toolClass: "destructive", verb: first };
  // Reading a delete log is still reading, so a leading read verb stops the scan below.
  if (!leadsWithRead)
    for (const p of parts)
      if (DESTRUCTIVE_VERBS.includes(p)) return { toolClass: "destructive", verb: p };
  // Namespaced names (mcp__figma__get_page, codegraph_status) put the verb after the prefix.
  for (const p of parts) {
    if (READ_VERBS.includes(p) || AMBIGUOUS_READ_VERBS.includes(p))
      return { toolClass: "read-only", verb: p };
    if (IDEMPOTENT_VERBS.includes(p)) return { toolClass: "idempotent-write", verb: p };
    if (WRITE_VERBS.includes(p)) return { toolClass: "write", verb: p };
  }
  return undefined;
}

/**
 * Whether a name and description are plain enough to take a tool *down* to read-only. Every clause
 * here exists because a real tool would break the rule without it: `find_and_replace`, `get_lock`,
 * `check_out_book`, `read_and_clear`, `get_delete_history`.
 */
export function readsOnly(tool: string, description?: string): boolean {
  const parts = segments(tool);
  const leading = parts.find(
    (p) =>
      READ_VERBS.includes(p) ||
      AMBIGUOUS_READ_VERBS.includes(p) ||
      MUTATING.has(p) ||
      CONJUNCTIONS.includes(p),
  );
  if (leading === undefined || !READ_VERBS.includes(leading)) return false;
  if (parts.some((p) => CONJUNCTIONS.includes(p))) return false;
  if (parts.some((p) => MUTATING.has(p))) return false;
  return !MUTATING_PROSE.test(firstSentence(description));
}

const RANK: Record<ToolClass, number> = {
  "read-only": 0,
  "idempotent-write": 1,
  write: 2,
  destructive: 3,
};

/** A tool as the server declared it. */
export interface DeclaredTool {
  name: string;
  annotations?: ToolAnnotations | undefined;
  description?: string | undefined;
}

/** Read a tools/list result into the shape this module works on. */
export function declaredTools(tools: unknown): DeclaredTool[] {
  if (!Array.isArray(tools)) return [];
  const out: DeclaredTool[] = [];
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue;
    const { name, annotations, description } = t as Record<string, unknown>;
    if (typeof name !== "string") continue;
    out.push({
      name,
      annotations:
        typeof annotations === "object" && annotations !== null
          ? (annotations as ToolAnnotations)
          : undefined,
      description: typeof description === "string" ? description : undefined,
    });
  }
  return out;
}

const declaresSomething = (a: ToolAnnotations | undefined): boolean =>
  a !== undefined &&
  (a.readOnlyHint !== undefined ||
    a.destructiveHint !== undefined ||
    a.idempotentHint !== undefined);

export function describeAnnotations(a: ToolAnnotations | undefined): string {
  if (!a || !declaresSomething(a)) return "nothing";
  const parts: string[] = [];
  if (a.readOnlyHint !== undefined) parts.push(`readOnlyHint ${a.readOnlyHint}`);
  if (a.destructiveHint !== undefined) parts.push(`destructiveHint ${a.destructiveHint}`);
  if (a.idempotentHint !== undefined) parts.push(`idempotentHint ${a.idempotentHint}`);
  return parts.join(", ");
}

/**
 * The class table for one server. Suggestions are conservative in the direction that matters: a
 * lowering needs the whole name and the description's first sentence to read as a read, while a
 * raising only needs the name to name an act.
 */
export function classReport(
  server: string,
  tools: DeclaredTool[],
  overrides: Record<string, ToolClass> = {},
): ClassReport {
  const rows: ToolClassRow[] = [];
  const counts: Record<ToolClass, number> = {
    "read-only": 0,
    "idempotent-write": 0,
    write: 0,
    destructive: 0,
  };
  let undeclared = 0;
  let fallback = 0;
  for (const t of tools) {
    const override = overrides[t.name];
    const declared = classify(t.annotations);
    const toolClass = override ?? declared;
    const source: ToolClassRow["source"] = override
      ? "override"
      : declaresSomething(t.annotations)
        ? "annotation"
        : "fallback";
    if (!declaresSomething(t.annotations)) undeclared++;
    if (source === "fallback") fallback++;
    counts[toolClass]++;
    const row: ToolClassRow = {
      tool: t.name,
      toolClass,
      source,
      annotations: t.annotations,
      effect: EFFECTS[toolClass],
    };
    const a = t.annotations;
    if (a?.readOnlyHint === true && a.destructiveHint === true)
      row.warning = "declared both read-only and destructive; the boundary reads it as read-only";
    const named = classFromName(t.name);
    if (!override && named && named.toolClass !== toolClass) {
      const direction: Direction = RANK[named.toolClass] < RANK[toolClass] ? "lower" : "raise";
      // A lowering has to survive the whole name and the first sentence, not just a leading verb.
      const allowed =
        direction === "raise" ||
        (named.toolClass === "read-only" && readsOnly(t.name, t.description));
      if (allowed) {
        const because =
          source === "fallback"
            ? "the server declares no annotations"
            : `the server declares ${describeAnnotations(a)}`;
        row.suggestion = {
          toolClass: named.toolClass,
          direction,
          reason: `the name reads as "${named.verb}" but ${because}`,
        };
        const caution =
          direction === "lower"
            ? "lowering drops the hold, allows a retry and allows a pre-send coercion: check the tool really only reads"
            : source === "annotation"
              ? "the name reads like a change but the server calls it safe"
              : undefined;
        if (caution && row.warning === undefined) row.warning = caution;
      }
    }
    rows.push(row);
  }
  return {
    server,
    rows,
    counts,
    undeclared,
    fallback,
    suggestions: rows.filter((r) => r.suggestion !== undefined),
  };
}

/**
 * The table a `--write` would store: everything already written down, plus the suggestions taken.
 * Overrides for tools this listing did not show are kept, because a tool absent from one
 * `tools/list` (a page not fetched, a flag switched off) has not stopped existing.
 */
export function overridesFrom(
  report: ClassReport,
  existing: Record<string, ToolClass> = {},
  take: Direction[] = ["raise", "lower"],
): Record<string, ToolClass> {
  const out: Record<string, ToolClass> = { ...existing };
  for (const r of report.rows) {
    if (r.suggestion && take.includes(r.suggestion.direction)) out[r.tool] = r.suggestion.toolClass;
    else if (r.source === "override") out[r.tool] = r.toolClass;
  }
  return out;
}

/** The suggestions of one direction, for a command that applies the two separately. */
export const suggestionsOf = (report: ClassReport, direction: Direction): ToolClassRow[] =>
  report.suggestions.filter((r) => r.suggestion?.direction === direction);
