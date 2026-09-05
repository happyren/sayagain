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
export const RULE_SET_VERSION = "2026-09-05";

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
      "Strings that look like ids, dates or enums carry `format`, `pattern` or `enum`; numbers carry bounds.",
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
  /\b(one of|either|allowed values|must be (a|an|one)|in the form|ISO ?8601|RFC ?3339|YYYY|uuid|format)\b/i;
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

  const props = tool.inputSchema.properties ?? {};
  for (const [key, schema] of Object.entries(props)) {
    if (!schema.description || schema.description.trim().length === 0)
      emit("params/described", `parameter ${key} has no description`, `/properties/${key}`);
  }
  for (const [key, schema] of Object.entries(props)) {
    const types = typeOf(schema);
    const path = `/properties/${key}`;
    if (types.includes("number") || types.includes("integer")) {
      if (!hasNumberConstraint(schema))
        emit("params/constrained", `number ${key} has no bounds (minimum, maximum, enum)`, path);
    } else if (types.includes("string") || (!types.length && schema.enum === undefined)) {
      const looksConstrained =
        CONSTRAINED_NAME.test(key) || CONSTRAINED_DESC.test(schema.description ?? "");
      if (looksConstrained && !hasStringConstraint(schema))
        emit(
          "params/constrained",
          `${key} reads as an id, date or choice but carries no format, pattern or enum`,
          path,
        );
    }
  }
  if (tool.inputSchema.required === undefined)
    emit("params/required-listed", "inputSchema has no `required` array");
  if (tool.inputSchema.additionalProperties !== false)
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
