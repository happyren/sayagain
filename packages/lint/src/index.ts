/**
 * @sayagain/lint — rules for MCP tool definitions.
 *
 * The catalogue below is the whitepaper's rule set. Rules marked
 * `implemented: false` are documented intent, not yet checks.
 */

export type Severity = "error" | "warning" | "info";
export type Category =
  | "naming"
  | "scope"
  | "parameters"
  | "cross-tool"
  | "output"
  | "cross-parameter"
  | "annotations"
  | "examples";

export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  summary: string;
  implemented: boolean;
}

/**
 * The rule set's version: the date the catalogue or a check last changed. A scan or a grade
 * quotes it so the number can be reproduced (docs/measurement.md 5.5).
 */
export const RULE_SET_VERSION = "2026-09-06.1";

export const RULES: readonly Rule[] = [
  {
    id: "name/format",
    category: "naming",
    severity: "error",
    summary: "Tool name is 1 to 128 characters of letters, digits, `_`, `-` or `.`.",
    implemented: true,
  },
  {
    id: "name/verb",
    category: "naming",
    severity: "info",
    summary: "Tool name starts with a verb (`create_issue`, not `issue`).",
    implemented: false,
  },
  {
    id: "description/present",
    category: "scope",
    severity: "error",
    summary: "Tool has a description.",
    implemented: true,
  },
  {
    id: "description/scope",
    category: "scope",
    severity: "warning",
    summary: "Description says when to use the tool and when not to.",
    implemented: false,
  },
  {
    id: "description/length",
    category: "scope",
    severity: "warning",
    summary:
      "Description is long enough to carry scope, constraints and output (at least 40 characters).",
    implemented: true,
  },
  {
    id: "params/described",
    category: "parameters",
    severity: "error",
    summary: "Every input property has a description.",
    implemented: true,
  },
  {
    id: "params/constrained",
    category: "parameters",
    severity: "warning",
    summary:
      "A string that reads as an id, date or choice carries `format`, `pattern`, `enum`, `const` or a length bound; a number carries a bound, `multipleOf`, `enum` or `const`.",
    implemented: true,
  },
  {
    id: "params/required-listed",
    category: "parameters",
    severity: "warning",
    summary: "`required` is present, even if empty.",
    implemented: true,
  },
  {
    id: "params/closed",
    category: "parameters",
    severity: "info",
    summary: "`additionalProperties` is false so stray arguments fail fast.",
    implemented: true,
  },
  {
    id: "cross-tool/prerequisites",
    category: "cross-tool",
    severity: "warning",
    summary: "Description names the tools that must run first, if any.",
    implemented: false,
  },
  {
    id: "output/described",
    category: "output",
    severity: "warning",
    summary: "Tool has an `outputSchema` or its description states what comes back.",
    implemented: true,
  },
  {
    id: "cross-parameter/documented",
    category: "cross-parameter",
    severity: "info",
    summary: "Dependencies between parameters (if X then Y is required) are stated.",
    implemented: false,
  },
  {
    id: "annotations/present",
    category: "annotations",
    severity: "warning",
    summary: "Tool declares `readOnlyHint`, `destructiveHint` and `idempotentHint`.",
    implemented: true,
  },
  {
    id: "annotations/consistent",
    category: "annotations",
    severity: "error",
    summary: "A tool is not both read-only and destructive.",
    implemented: true,
  },
  {
    id: "annotations/compensation",
    category: "annotations",
    severity: "info",
    summary:
      'A tool that is neither read-only nor idempotent declares how to undo it, or that it cannot be undone (`_meta["sh.sayagain/compensation"]`, spec section 8).',
    implemented: true,
  },
  {
    id: "annotations/verify",
    category: "annotations",
    severity: "info",
    summary:
      "A tool that is neither read-only nor idempotent declares how to read its effect back (`sh.sayagain/verify`), so a boundary can look before re-sending a call whose outcome was lost.",
    implemented: true,
  },
  {
    id: "examples/present",
    category: "examples",
    severity: "info",
    summary: "Description or schema includes at least one example call.",
    implemented: false,
  },
];

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  $ref?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Reverse-DNS keys; `sh.sayagain/compensation` and `sh.sayagain/idempotency` are read here. */
  _meta?: Record<string, unknown>;
}

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  path?: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** Property names that read as an id, a date, a time, or a choice among a few values. */
const CONSTRAINED_NAME =
  /(^|_|-)(id|ids|uuid|guid|key|token|sha|hash|date|datetime|time|timestamp|at|before|after|since|until|status|state|type|kind|mode|format|level|priority|visibility|sort|order|direction|role|scope|unit|currency|locale|lang|language|region|country|timezone|tz)$/i;
const CONSTRAINED_DESC =
  /\b(one of|either|allowed values|must be (a|an|one)|in the form(at)? of|the format|formatted as|ISO ?8601|RFC ?3339|YYYY|uuid)\b/i;
/** A union's branches (anyOf, oneOf, allOf), or the schema itself. */
const branchesOf = (s: JsonSchema, depth = 0): JsonSchema[] => {
  const alts = [s.anyOf, s.oneOf, s.allOf]
    .filter((x): x is JsonSchema[] => Array.isArray(x))
    .flat()
    .filter((x): x is JsonSchema => typeof x === "object" && x !== null);
  return alts.length && depth < 4 ? alts.flatMap((b) => branchesOf(b, depth + 1)) : [s];
};
const typeOf = (s: JsonSchema): string[] =>
  Array.isArray(s.type) ? s.type : typeof s.type === "string" ? [s.type] : [];
const hasStringConstraint = (s: JsonSchema): boolean =>
  s.enum !== undefined ||
  s.format !== undefined ||
  s.pattern !== undefined ||
  s.const !== undefined ||
  s.minLength !== undefined ||
  s.maxLength !== undefined;
const hasNumberConstraint = (s: JsonSchema): boolean =>
  s.minimum !== undefined ||
  s.maximum !== undefined ||
  s.exclusiveMinimum !== undefined ||
  s.exclusiveMaximum !== undefined ||
  s.multipleOf !== undefined ||
  s.enum !== undefined ||
  s.const !== undefined;

export function lintTool(tool: ToolDefinition): Finding[] {
  const out: Finding[] = [];
  const emit = (rule: string, message: string, path?: string) => {
    const def = RULES.find((r) => r.id === rule);
    if (!def) throw new Error(`unknown rule ${rule}`);
    out.push(
      path === undefined
        ? { rule, severity: def.severity, message }
        : { rule, severity: def.severity, message, path },
    );
  };

  if (!NAME.test(tool.name))
    emit(
      "name/format",
      `name ${JSON.stringify(tool.name)} is not 1 to 128 chars of [A-Za-z0-9_.-]`,
    );

  const desc = tool.description?.trim() ?? "";
  if (desc.length === 0) emit("description/present", "tool has no description");
  else if (desc.length < 40)
    emit(
      "description/length",
      `description is ${desc.length} characters; too short to carry scope, constraints and output`,
    );

  const input: JsonSchema =
    typeof tool.inputSchema === "object" && tool.inputSchema !== null ? tool.inputSchema : {};
  const props = Object.entries(input.properties ?? {}).filter(
    (e): e is [string, JsonSchema] => typeof e[1] === "object" && e[1] !== null,
  );
  for (const [key, schema] of props) {
    if (!schema.description || schema.description.trim().length === 0)
      emit("params/described", `parameter ${key} has no description`, `/properties/${key}`);
  }
  for (const [key, schema] of props) {
    const path = `/properties/${key}`;
    const branches = branchesOf(schema);
    // A reference is a definition elsewhere: the linter cannot judge it, so it does not.
    if (schema.$ref !== undefined || branches.some((b) => b.$ref !== undefined)) continue;
    const types = new Set(branches.flatMap(typeOf).filter((t) => t !== "null"));
    if ((types.has("number") || types.has("integer")) && !types.has("string")) {
      if (!branches.some(hasNumberConstraint))
        emit("params/constrained", `number ${key} has no bounds (minimum, maximum, enum)`, path);
    } else if (types.has("string")) {
      const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"); // userId reads as user_id
      const looksConstrained =
        CONSTRAINED_NAME.test(snake) || CONSTRAINED_DESC.test(schema.description ?? "");
      if (looksConstrained && !branches.some(hasStringConstraint))
        emit(
          "params/constrained",
          `${key} reads as an id, date or choice but carries no format, pattern or enum`,
          path,
        );
    }
  }
  if (input.required === undefined)
    emit("params/required-listed", "inputSchema has no `required` array");
  if (input.additionalProperties !== false)
    emit("params/closed", "inputSchema does not set additionalProperties: false");

  if (!tool.outputSchema && !/\b(returns?|responds? with|yields?|gives back|output)\b/i.test(desc))
    emit(
      "output/described",
      "no outputSchema and the description does not say what the tool returns",
    );

  const a = tool.annotations;
  if (
    !a ||
    a.readOnlyHint === undefined ||
    a.destructiveHint === undefined ||
    a.idempotentHint === undefined
  )
    emit(
      "annotations/present",
      "readOnlyHint, destructiveHint and idempotentHint are not all declared",
    );
  if (a?.readOnlyHint === true && a.destructiveHint === true)
    emit("annotations/consistent", "tool is annotated both read-only and destructive");
  const undoable = a?.readOnlyHint !== true && a?.idempotentHint !== true;
  if (undoable && tool._meta?.["sh.sayagain/compensation"] === undefined)
    emit(
      "annotations/compensation",
      "neither read-only nor idempotent, and no compensation is declared (nor that none exists)",
    );
  const verify = tool._meta?.["sh.sayagain/verify"];
  if (undoable && verify === undefined)
    emit(
      "annotations/verify",
      "neither read-only nor idempotent, and no way to read its effect back is declared",
    );
  else if (verify !== undefined) {
    // A declaration the boundary would refuse is worse than none: it reads as a promise.
    const v = verify as { tool?: unknown; arguments?: unknown; effect?: unknown };
    const declared = tool.inputSchema?.properties;
    const props = declared ? new Set(Object.keys(declared)) : null;
    const args =
      typeof v.arguments === "object" && v.arguments !== null && !Array.isArray(v.arguments)
        ? Object.values(v.arguments as Record<string, unknown>)
        : [];
    const refs = args.filter((a) => typeof a === "string" && a.startsWith("$arguments."));
    const bad = args.filter(
      (a) => typeof a !== "string" || (a.startsWith("$") && !a.startsWith("$arguments.")),
    );
    const unknownRef = props
      ? refs.filter((a) => !props.has(String(a).slice("$arguments.".length)))
      : [];
    if (typeof v.tool !== "string" || !v.tool)
      emit("annotations/verify", "sh.sayagain/verify names no tool");
    else if (bad.length)
      emit(
        "annotations/verify",
        "sh.sayagain/verify uses a template other than a literal or $arguments.<name>, which a boundary cannot resolve",
      );
    else if (!refs.length)
      emit(
        "annotations/verify",
        "sh.sayagain/verify reads nothing from the call, so it would find every write present",
      );
    else if (unknownRef.length)
      emit(
        "annotations/verify",
        `sh.sayagain/verify refers to ${unknownRef.join(", ")}, which the tool does not take`,
      );
    else if (v.effect !== undefined && v.effect !== "result" && v.effect !== "absence")
      emit("annotations/verify", "sh.sayagain/verify effect must be result or absence");
  }

  return out;
}

/** Letter grade from findings, weighted by severity. A means nothing above info. */
export function grade(findings: Finding[]): "A" | "B" | "C" | "D" | "F" {
  const score = findings.reduce(
    (n, f) => n + (f.severity === "error" ? 3 : f.severity === "warning" ? 1 : 0),
    0,
  );
  if (score === 0) return "A";
  if (score <= 1) return "B";
  if (score <= 3) return "C";
  if (score <= 6) return "D";
  return "F";
}
