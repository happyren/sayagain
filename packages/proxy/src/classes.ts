/**
 * What class each tool gets, where that class came from, and what to do when the server's own
 * annotations are missing or wrong (ADR-0012).
 *
 * The boundary's whole behaviour hangs off the class: a read-only call is retried and may be
 * coerced before it leaves, a destructive one is held. A server that declares nothing leaves every
 * tool in the cautious fallback, and a server that declares badly can put a screenshot behind an
 * approval. Neither is visible from the outside, so this module names the class, its source, and a
 * suggestion the operator can read before writing it down.
 */
import { classify, type ToolAnnotations, type ToolClass } from "@sayagain/sdk";

/** One tool as the boundary sees it. */
export interface ToolClassRow {
  tool: string;
  toolClass: ToolClass;
  /** Where the class came from: the operator's table, the server's annotations, or the fallback. */
  source: "override" | "annotation" | "fallback";
  annotations: ToolAnnotations | undefined;
  /** What the boundary does with this class, in one clause. */
  effect: string;
  /** Set when the declaration contradicts itself or the tool's own name. */
  warning?: string;
  /** A class worth considering instead, with the reason; never applied on its own. */
  suggestion?: { toolClass: ToolClass; reason: string };
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

const EFFECTS: Record<ToolClass, string> = {
  "read-only":
    "retried on a retryable failure, never held, never deduplicated, may be coerced before it leaves",
  "idempotent-write":
    "retried on a retryable failure, deduplicated within the window, held only under --hold always",
  write: "never retried, deduplicated within the window, held only under --hold always",
  destructive:
    "never retried, deduplicated within the window, held for a decision under the default policy",
};

/** Leading words that say a tool reads. Matched on the first segment of the name, and on the whole name. */
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
  "check",
  "count",
  "lookup",
  "explore",
  "trace",
  "preview",
  "diff",
  "validate",
  "verify",
  "resolve",
  "peek",
  "summarize",
  "summarise",
  "analyze",
  "analyse",
];
/** Leading words that say a tool changes something, and repeating it lands in the same place. */
const IDEMPOTENT_VERBS = [
  "set",
  "put",
  "upsert",
  "ensure",
  "open",
  "select",
  "focus",
  "clear",
  "reset_view",
];
/** Leading words that say a tool changes something. */
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
];
/** Leading words that say a tool destroys something a person would miss. */
const DESTRUCTIVE_VERBS = [
  "delete",
  "remove",
  "drop",
  "destroy",
  "purge",
  "wipe",
  "truncate",
  "revoke",
  "kill",
  "terminate",
  "uninstall",
  "erase",
  "prune",
  "discard",
];

const segments = (tool: string): string[] =>
  tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The class a tool's name suggests, or undefined when the name says nothing. */
export function classFromName(tool: string): { toolClass: ToolClass; verb: string } | undefined {
  const parts = segments(tool);
  // A leading verb decides; a later one (delete_page_batch) is checked too, but only for destruction,
  // where a false negative is the expensive direction.
  const first = parts[0] ?? "";
  const has = (verbs: string[], word: string) => verbs.includes(word);
  if (has(DESTRUCTIVE_VERBS, first)) return { toolClass: "destructive", verb: first };
  for (const p of parts)
    if (has(DESTRUCTIVE_VERBS, p)) return { toolClass: "destructive", verb: p };
  if (has(READ_VERBS, first)) return { toolClass: "read-only", verb: first };
  if (has(IDEMPOTENT_VERBS, first)) return { toolClass: "idempotent-write", verb: first };
  if (has(WRITE_VERBS, first)) return { toolClass: "write", verb: first };
  return undefined;
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

/**
 * The class table for one server. Suggestions are conservative: the name has to disagree with the
 * declaration, and a suggestion that lowers the class needs the name to read like a read.
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
      const lowering = RANK[named.toolClass] < RANK[toolClass];
      const raising = RANK[named.toolClass] > RANK[toolClass];
      // Lowering is the expensive direction to get wrong, so only a reading name earns it.
      if (!lowering || named.toolClass === "read-only") {
        const because =
          source === "fallback"
            ? "the server declares no annotations"
            : `the server declares ${describeAnnotations(a)}`;
        row.suggestion = {
          toolClass: named.toolClass,
          reason: `the name starts with "${named.verb}" but ${because}`,
        };
        if (raising && source === "annotation")
          row.warning ??= "the name reads like a change but the server calls it safe";
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

export function describeAnnotations(a: ToolAnnotations | undefined): string {
  if (!a || !declaresSomething(a)) return "nothing";
  const parts: string[] = [];
  if (a.readOnlyHint !== undefined) parts.push(`readOnlyHint ${a.readOnlyHint}`);
  if (a.destructiveHint !== undefined) parts.push(`destructiveHint ${a.destructiveHint}`);
  if (a.idempotentHint !== undefined) parts.push(`idempotentHint ${a.idempotentHint}`);
  return parts.join(", ");
}

/** The overrides a `--write` would store: the current table plus every suggestion taken. */
export function overridesFrom(report: ClassReport): Record<string, ToolClass> {
  const out: Record<string, ToolClass> = {};
  for (const r of report.rows) {
    if (r.suggestion) out[r.tool] = r.suggestion.toolClass;
    else if (r.source === "override") out[r.tool] = r.toolClass;
  }
  return out;
}
