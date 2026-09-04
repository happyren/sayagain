/**
 * Deterministic argument repair from a tool's own inputSchema: type
 * coercions, key renames by normalised name, defaults for missing required
 * properties. No model, no guessing; every change is recorded.
 */

export interface RepairChange {
  path: string;
  rule: string;
  from?: unknown;
  to?: unknown;
}

export interface RepairResult {
  arguments: Record<string, unknown>;
  changes: RepairChange[];
}

interface Prop {
  type?: string | string[];
  items?: { type?: string | string[] };
  default?: unknown;
  enum?: unknown[];
}

interface Schema {
  properties?: Record<string, Prop>;
  required?: string[];
}

const typesOf = (p: Prop | undefined): string[] =>
  p?.type === undefined ? [] : Array.isArray(p.type) ? p.type : [p.type];
const normalise = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
const isScalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);

export function repairArguments(args: unknown, schema: unknown): RepairResult | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  if (typeof schema !== "object" || schema === null) return null;
  const { properties = {}, required = [] } = schema as Schema;
  const out: Record<string, unknown> = {};
  const changes: RepairChange[] = [];
  const propNames = Object.keys(properties);

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    let name = key;
    if (!(key in properties)) {
      const match = propNames.find(
        (p) => normalise(p) === normalise(key) && !(p in (args as object)),
      );
      if (match) {
        changes.push({ path: `/${key}`, rule: "rename", to: `/${match}` });
        name = match;
      } else {
        out[key] = value;
        continue;
      }
    }
    const prop = properties[name];
    const types = typesOf(prop);
    let next = value;
    let rule: string | undefined;
    const wantsNumber = types.includes("number") || types.includes("integer");
    const wantsString = types.includes("string");
    const wantsArray = types.includes("array");
    const wantsObject = types.includes("object");
    if (wantsNumber && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      next = Number(value);
      rule = "string-to-number";
    }
    if (
      !rule &&
      types.includes("boolean") &&
      typeof value === "string" &&
      /^(true|false)$/i.test(value.trim())
    ) {
      next = value.trim().toLowerCase() === "true";
      rule = "string-to-boolean";
    }
    if (!rule && (wantsObject || wantsArray) && typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        const isArr = Array.isArray(parsed);
        const isObj = typeof parsed === "object" && parsed !== null && !isArr;
        if ((wantsArray && isArr) || (wantsObject && isObj)) {
          next = parsed;
          rule = "json-string-to-value";
        }
      } catch {
        // not JSON; other rules may still apply
      }
    }
    if (!rule && wantsString && !wantsArray && Array.isArray(value) && value.every(isScalar)) {
      next = value.join(",");
      rule = "array-to-comma-string";
    }
    if (!rule && wantsString && !wantsNumber && typeof value === "number") {
      next = String(value);
      rule = "number-to-string";
    }
    if (!rule && wantsArray && !Array.isArray(value) && isScalar(value)) {
      const itemTypes = typesOf(prop?.items);
      if (!itemTypes.length || itemTypes.includes(typeof value)) {
        next = [value];
        rule = "scalar-to-array";
      }
    }
    if (rule) changes.push({ path: `/${name}`, rule, from: value, to: next });
    out[name] = next;
  }

  for (const key of required) {
    if (key in out) continue;
    const prop = properties[key];
    if (prop && prop.default !== undefined) {
      out[key] = prop.default;
      changes.push({ path: `/${key}`, rule: "default", to: prop.default });
    }
  }

  return changes.length ? { arguments: out, changes } : null;
}
