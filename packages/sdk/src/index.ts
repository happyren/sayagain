/**
 * Say Again intent metadata for MCP tool calls.
 * Wire format: spec/intent-metadata.md (draft v0.1).
 */

/** Reverse-DNS prefix for every key this convention defines. */
export const META_PREFIX = "sh.sayagain/" as const;

/** `_meta` keys on `tools/call` requests and results. */
export const META = {
  intent: `${META_PREFIX}intent`,
  expect: `${META_PREFIX}expect`,
  task: `${META_PREFIX}task`,
  idempotencyKey: `${META_PREFIX}idempotency-key`,
  policy: `${META_PREFIX}policy`,
  receipt: `${META_PREFIX}receipt`,
  status: `${META_PREFIX}status`,
  held: `${META_PREFIX}held`,
  repair: `${META_PREFIX}repair`,
  boundary: `${META_PREFIX}boundary`,
  duplicateOf: `${META_PREFIX}duplicate-of`,
  replayOf: `${META_PREFIX}replay-of`,
} as const;

/** Transport header carrying task-level intent (spec section 4). */
export const TASK_INTENT_HEADER = "Sayagain-Task-Intent";
/** Transport header carrying the task id (spec section 3.3). */
export const TASK_HEADER = "Sayagain-Task";

/** Result status (spec section 5.2). */
export type Status = "executed" | "repaired" | "held" | "queued" | "deduplicated" | "dead-lettered";

export const STATUSES: readonly Status[] = [
  "executed",
  "repaired",
  "held",
  "queued",
  "deduplicated",
  "dead-lettered",
] as const;

/** Radio procedure word shown for each status in consoles and logs. */
export const PROWORD: Readonly<Record<Status, string>> = {
  queued: "ROGER",
  executed: "WILCO",
  repaired: "CORRECTION",
  held: "STANDBY",
  deduplicated: "DISREGARD",
  "dead-lettered": "UNABLE",
};

/** Repair budget before a call is dead-lettered (spec section 8). */
export const REPAIR_BUDGET = { perCall: 1, perTask: 3 } as const;

/** Tool classification used by the hold policy (ADR-0004). */
export type ToolClass = "read-only" | "idempotent-write" | "write" | "destructive";

/** The subset of MCP tool annotations the classifier reads. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Classify a tool from its annotations alone. Unknown tools are `write`,
 * because the cost of treating a write as read-only is unbounded and the
 * cost of the reverse is one extra hold. Operator tables override this.
 */
export function classify(annotations?: ToolAnnotations): ToolClass {
  if (!annotations) return "write";
  if (annotations.readOnlyHint === true) return "read-only";
  if (annotations.destructiveHint === true) return "destructive";
  if (annotations.idempotentHint === true) return "idempotent-write";
  return "write";
}

export interface ExpectProbe {
  tool: string;
  arguments: Record<string, unknown>;
  assert: string;
}

export interface IntentFields {
  intent?: string;
  expect?: string | ExpectProbe;
  task?: string;
  idempotencyKey?: string;
  policy?: { hold?: "auto" | "always" | "never" };
}

export type Meta = Record<string, unknown>;

/**
 * Build the `_meta` object for a `tools/call` request from intent fields.
 * Keys with undefined values are omitted so the wire stays minimal.
 */
export function buildMeta(fields: IntentFields): Meta {
  const meta: Meta = {};
  if (fields.intent !== undefined) meta[META.intent] = fields.intent;
  if (fields.expect !== undefined) meta[META.expect] = fields.expect;
  if (fields.task !== undefined) meta[META.task] = fields.task;
  if (fields.idempotencyKey !== undefined) meta[META.idempotencyKey] = fields.idempotencyKey;
  if (fields.policy !== undefined) meta[META.policy] = fields.policy;
  return meta;
}

/**
 * Attach intent to a call. Returns the `params` fragment for `tools/call`.
 */
export function withIntent(
  name: string,
  args: Record<string, unknown>,
  fields: IntentFields,
): { name: string; arguments: Record<string, unknown>; _meta: Meta } {
  return { name, arguments: args, _meta: buildMeta(fields) };
}

/** Default property names the schema shim injects (spec section 7). */
export const SHIM_PROPERTIES = { intent: "intent", expect: "expect" } as const;

/**
 * Schema-shim inverse: remove shim-captured properties from `arguments` and
 * merge them into `_meta`. Native `_meta` values win over shim values.
 */
export function stripShim(
  args: Record<string, unknown>,
  meta: Meta | undefined,
  names: { intent: string; expect: string } = SHIM_PROPERTIES,
): { arguments: Record<string, unknown>; _meta: Meta } {
  const out: Record<string, unknown> = { ...args };
  const merged: Meta = { ...(meta ?? {}) };
  const intent = out[names.intent];
  if (typeof intent === "string") {
    if (merged[META.intent] === undefined) merged[META.intent] = intent;
    delete out[names.intent];
  }
  const expect = out[names.expect];
  if (typeof expect === "string" || (typeof expect === "object" && expect !== null)) {
    if (merged[META.expect] === undefined) merged[META.expect] = expect;
    delete out[names.expect];
  }
  return { arguments: out, _meta: merged };
}
