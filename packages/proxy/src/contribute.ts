/**
 * `sayagain contribute`: the opt-in shape contribution of ADR-0009. One JSON document per
 * contribution, built locally from ledger or transcript rows, written to disk before anything
 * else, shown in full, and sent only after a `y` (or `--yes`) to an endpoint the operator named.
 * The document's fields are the whole list; `assertShapeDocumentSafe` refuses anything else.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  duplicateWrites,
  finalRows,
  isFailure,
  isUnacknowledged,
  selectRows,
  signatureStats,
} from "./analysis.js";
import { homePath } from "./home.js";
import type { LedgerRow } from "./ledger.js";
import { loadRegistry, type Registry, saveRegistry } from "./registry.js";

export const SHAPE_SCHEMA = "sayagain.shape/1";
/** The terms in docs/CONTRIBUTING-DATA.md that `--accept-terms` refers to. */
export const TERMS_VERSION = "2026-09-05";

export type ContributionSource =
  | "claude-code-transcripts"
  | "cursor-transcripts"
  | "codex-transcripts"
  | "ledger"
  | "claude-code-hook"
  | "litellm"
  | "contextforge";
export type Resolution =
  | "type-change"
  | "added-key"
  | "removed-key"
  | "other-tool-first"
  | "retry-same"
  | "none";
export type IntentCategory =
  | "read"
  | "search"
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "unknown";

export interface Consent {
  termsVersion: string;
  acceptedAt: string;
}

export interface ShapeError {
  class: string;
  /** 64 bits of SHA-256 of the masked signature; the text stays home. */
  signatureHash: string;
  count: number;
  /** Sorted key:type entries of the most common failing call. */
  argShape: string[];
  resolution: Resolution;
  shapeChange?: string;
  recoveryPath?: string[];
  callsToRecover: { median: number; unrecovered: number };
  boundary: { repaired: number; held: number; deadLettered: number };
}

export interface Shape {
  server: string;
  serverVersion?: string;
  tool: string;
  schemaHash?: string;
  toolClass: string;
  modelFamily: string;
  intentCategory: IntentCategory;
  calls: number;
  failures: number;
  unacknowledgedWrites: number;
  duplicateWrites: number;
  errors: ShapeError[];
}

export interface ShapeDocument {
  schema: typeof SHAPE_SCHEMA;
  contributor: string;
  consent: Consent;
  client: { name: "sayagain"; version: string; source: ContributionSource };
  window: { since: string; until: string };
  sessions: number;
  shapes: Shape[];
}

export type ContributeSettings = NonNullable<Registry["contribute"]>;

const READ =
  /^(get|list|read|fetch|describe|show|view|check|status|count|lookup|whoami|inspect|browse|preview|resolve|validate|explain)/i;
const SEARCH = /^(search|find|query|grep|glob)/i;
const CREATE = /^(create|add|insert|post|send|publish|upload|invite|reply|submit|new)/i;
const UPDATE =
  /^(update|set|edit|patch|put|replace|move|rename|write|save|assign|approve|reject|close|open|archive|merge|push)/i;
const DELETE = /^(delete|remove|trash|drop|purge|destroy|wipe|reset)/i;
const EXECUTE =
  /^(execute|run|trigger|start|stop|restart|kill|deploy|apply|cancel|exec|shell|bash|command)/i;

/** From the tool's name and class, never from intent text. */
export function intentCategory(tool: string, toolClass: string): IntentCategory {
  const verb = tool.split("__").pop() ?? tool;
  if (DELETE.test(verb) || toolClass === "destructive") return "delete";
  if (SEARCH.test(verb)) return "search";
  if (READ.test(verb)) return "read";
  if (EXECUTE.test(verb)) return "execute";
  if (CREATE.test(verb)) return "create";
  if (UPDATE.test(verb)) return "update";
  if (toolClass === "read-only") return "read";
  return "unknown";
}

export const signatureHash = (signature: string): string =>
  createHash("sha256").update(signature).digest("hex").slice(0, 16);

export interface BuildOptions {
  source: ContributionSource;
  contributor: string;
  consent: Consent;
  since: Date;
  until?: Date;
  version: string;
  sessions?: number;
  /** The model family behind a row (transcripts know it; the ledger does not). */
  familyOf?: (r: LedgerRow) => string;
  schemaHashOf?: (r: LedgerRow) => string | undefined;
  /** Errors kept per shape, most frequent first. Default 10. */
  maxErrors?: number;
}

const modeOf = <T>(xs: T[], key: (x: T) => string): T | undefined => {
  const counts = new Map<string, { n: number; x: T }>();
  for (const x of xs) {
    const k = key(x);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { n: 1, x });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.x;
};

const resolutionOf = (
  shapeChange: string | undefined,
  recoveryPath: string | undefined,
  recovered: boolean,
): Resolution => {
  if (shapeChange?.startsWith("changed")) return "type-change";
  if (shapeChange?.startsWith("added")) return "added-key";
  if (shapeChange?.startsWith("removed")) return "removed-key";
  if (recoveryPath && recoveryPath !== "(retry only)") return "other-tool-first";
  return recovered ? "retry-same" : "none";
};

interface Group {
  server: string;
  tool: string;
  family: string;
  toolClass: string;
  calls: number;
  failures: number;
  unack: number;
  dup: number;
  schemaHash?: string;
}

/** The document, from rows alone. Argument values never enter: rows carry shapes and hashes only. */
export function buildShapeDocument(allRows: LedgerRow[], opts: BuildOptions): ShapeDocument {
  const until = opts.until ?? new Date();
  const familyOf = opts.familyOf ?? (() => "unknown");
  const rows = selectRows(allRows, { until });
  const inWindow = (r: LedgerRow) => Date.parse(r.ts) >= opts.since.getTime();
  const finals = finalRows(rows).filter((r) => inWindow(r) && r.status !== "deduplicated");
  const byReceipt = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const list = byReceipt.get(r.receipt);
    if (list) list.push(r);
    else byReceipt.set(r.receipt, [r]);
  }
  const keyOf = (r: LedgerRow) => `${r.upstream} ${r.tool} ${familyOf(r)}`;
  const groups = new Map<string, Group>();
  const groupFor = (r: LedgerRow): Group => {
    const k = keyOf(r);
    let g = groups.get(k);
    if (!g) {
      g = {
        server: r.upstream,
        tool: r.tool,
        family: familyOf(r),
        toolClass: r.toolClass,
        calls: 0,
        failures: 0,
        unack: 0,
        dup: 0,
      };
      groups.set(k, g);
    }
    if (!g.schemaHash) {
      const h = opts.schemaHashOf?.(r);
      if (h) g.schemaHash = h;
    }
    return g;
  };
  for (const r of finals) {
    if (r.status === "held") continue;
    const g = groupFor(r);
    g.calls++;
    if (isFailure(r)) g.failures++;
    if (isUnacknowledged(r)) g.unack++;
  }
  for (const r of duplicateWrites(rows, { since: opts.since })) groupFor(r).dup++;

  const errorsByGroup = new Map<string, ShapeError[]>();
  const families = new Set([...groups.values()].map((g) => g.family));
  for (const family of families) {
    const partition = rows.filter((r) => familyOf(r) === family);
    for (const s of signatureStats(partition, { since: opts.since })) {
      const failing = partition.filter(
        (r) =>
          r.upstream === s.server &&
          r.tool === s.tool &&
          r.errorSignature === s.signature &&
          inWindow(r),
      );
      const boundary = { repaired: 0, held: 0, deadLettered: 0 };
      for (const receipt of new Set(failing.map((r) => r.receipt))) {
        const rowsOf = byReceipt.get(receipt) ?? [];
        const last = rowsOf[rowsOf.length - 1];
        if (!last) continue;
        if (last.status === "repaired") boundary.repaired++;
        if (last.held) boundary.held++;
        if (last.status === "dead-lettered") boundary.deadLettered++;
      }
      const argShape = modeOf(failing, (r) => r.argShape.join("\n"))?.argShape ?? [];
      const recoveryPath =
        s.topRecoveryPath && s.topRecoveryPath !== "(retry only)"
          ? s.topRecoveryPath.split(" > ").filter((x) => x && !x.startsWith("…"))
          : undefined;
      const entry: ShapeError = {
        class: s.errorClass,
        signatureHash: signatureHash(s.signature),
        count: s.count,
        argShape,
        resolution: resolutionOf(s.topShapeChange, s.topRecoveryPath, s.count > s.unrecovered),
        ...(s.topShapeChange ? { shapeChange: s.topShapeChange } : {}),
        ...(recoveryPath?.length ? { recoveryPath } : {}),
        callsToRecover: { median: s.medianCallsToRecover, unrecovered: s.unrecovered },
        boundary,
      };
      const k = `${s.server} ${s.tool} ${family}`;
      const list = errorsByGroup.get(k);
      if (list) list.push(entry);
      else errorsByGroup.set(k, [entry]);
    }
  }
  const maxErrors = opts.maxErrors ?? 10;
  const shapes: Shape[] = [...groups.entries()]
    .filter(([, g]) => g.calls > 0 && !OPAQUE_NAME.test(g.server))
    .map(([k, g]) => ({
      server: g.server.toLowerCase(),
      tool: g.tool,
      ...(g.schemaHash ? { schemaHash: g.schemaHash } : {}),
      toolClass: g.toolClass,
      modelFamily: g.family,
      intentCategory: intentCategory(g.tool, g.toolClass),
      calls: g.calls,
      failures: g.failures,
      unacknowledgedWrites: g.unack,
      duplicateWrites: g.dup,
      errors: (errorsByGroup.get(k) ?? []).sort((a, b) => b.count - a.count).slice(0, maxErrors),
    }))
    .sort((a, b) => b.calls - a.calls);
  const sessions = opts.sessions ?? new Set(finals.map((r) => r.session ?? r.receipt)).size;
  const doc: ShapeDocument = {
    schema: SHAPE_SCHEMA,
    contributor: opts.contributor,
    consent: opts.consent,
    client: { name: "sayagain", version: opts.version, source: opts.source },
    window: { since: opts.since.toISOString(), until: until.toISOString() },
    sessions,
    shapes,
  };
  assertShapeDocumentSafe(doc);
  return doc;
}

const KEYS = {
  document: ["schema", "contributor", "consent", "client", "window", "sessions", "shapes"],
  consent: ["termsVersion", "acceptedAt"],
  client: ["name", "version", "source"],
  window: ["since", "until"],
  shape: [
    "server",
    "serverVersion",
    "tool",
    "schemaHash",
    "toolClass",
    "modelFamily",
    "intentCategory",
    "calls",
    "failures",
    "unacknowledgedWrites",
    "duplicateWrites",
    "errors",
  ],
  error: [
    "class",
    "signatureHash",
    "count",
    "argShape",
    "resolution",
    "shapeChange",
    "recoveryPath",
    "callsToRecover",
    "boundary",
  ],
  callsToRecover: ["median", "unrecovered"],
  boundary: ["repaired", "held", "deadLettered"],
};
const ARG_SHAPE =
  /^[^:\s/\\]{1,120}:(string|number|boolean|object|array|null|undefined|bigint|symbol|function)$/;
const SHAPE_CHANGE =
  /^(added|removed|changed) [^\s/\\]{1,400}(; (added|removed|changed) [^\s/\\]{1,400})*$/;
const ENUM_WORD = /^[a-z-]{1,24}$/;
const HEX16 = /^[0-9a-f]{16}$/;
/** A server named by a UUID or a long hex id is someone's private connector, not a public server. */
export const OPAQUE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{20,}$/i;

function onlyKeys(o: unknown, allowed: string[], where: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new Error(`contribution: ${where} must be an object`);
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw new Error(`contribution: unexpected field ${where}.${k}`);
  return o as Record<string, unknown>;
}
const shortName = (v: unknown, where: string, max = 200): void => {
  if (typeof v !== "string" || !v || v.length > max)
    throw new Error(`contribution: ${where} must be a short name`);
  if (/\s|\\|\//.test(v))
    throw new Error(`contribution: ${where} must not contain spaces or paths`);
};
const count = (v: unknown, where: string): void => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error(`contribution: ${where} must be a count`);
};
const enumWord = (v: unknown, where: string): void => {
  if (typeof v !== "string" || !ENUM_WORD.test(v))
    throw new Error(`contribution: ${where} must be an enum word`);
};

function assertErrorSafe(rawErr: unknown, where: string): void {
  const e = onlyKeys(rawErr, KEYS.error, where);
  enumWord(e.class, `${where}.class`);
  if (!HEX16.test(String(e.signatureHash)))
    throw new Error(`contribution: ${where}.signatureHash must be 16 hex`);
  count(e.count, `${where}.count`);
  if (!Array.isArray(e.argShape) || e.argShape.some((x) => !ARG_SHAPE.test(String(x))))
    throw new Error(`contribution: ${where}.argShape must be key:type entries`);
  enumWord(e.resolution, `${where}.resolution`);
  if (e.shapeChange !== undefined && !SHAPE_CHANGE.test(String(e.shapeChange)))
    throw new Error(`contribution: ${where}.shapeChange must describe keys and types`);
  if (e.recoveryPath !== undefined) {
    if (!Array.isArray(e.recoveryPath) || e.recoveryPath.length > 8)
      throw new Error(`contribution: ${where}.recoveryPath must be a short list`);
    for (const [k, p] of e.recoveryPath.entries()) shortName(p, `${where}.recoveryPath[${k}]`);
  }
  const c = onlyKeys(e.callsToRecover, KEYS.callsToRecover, `${where}.callsToRecover`);
  count(c.median, `${where}.callsToRecover.median`);
  count(c.unrecovered, `${where}.callsToRecover.unrecovered`);
  const b = onlyKeys(e.boundary, KEYS.boundary, `${where}.boundary`);
  for (const k of KEYS.boundary) count(b[k], `${where}.boundary.${k}`);
}

function assertShapeSafe(raw: unknown, where: string): void {
  const s = onlyKeys(raw, KEYS.shape, where);
  shortName(s.server, `${where}.server`);
  if (OPAQUE_NAME.test(String(s.server)))
    throw new Error(`contribution: ${where}.server is an opaque id, not a public server`);
  shortName(s.tool, `${where}.tool`);
  if (s.serverVersion !== undefined) shortName(s.serverVersion, `${where}.serverVersion`, 64);
  if (s.schemaHash !== undefined && !HEX16.test(String(s.schemaHash)))
    throw new Error(`contribution: ${where}.schemaHash must be 16 hex`);
  for (const k of ["toolClass", "modelFamily", "intentCategory"]) enumWord(s[k], `${where}.${k}`);
  for (const k of ["calls", "failures", "unacknowledgedWrites", "duplicateWrites"])
    count(s[k], `${where}.${k}`);
  if (!Array.isArray(s.errors)) throw new Error(`contribution: ${where}.errors must be a list`);
  for (const [j, e] of s.errors.entries()) assertErrorSafe(e, `${where}.errors[${j}]`);
}

/**
 * The structural guarantee behind "nothing else is sent": every key is on the list, names are
 * short and carry no paths or spaces, hashes are hex, shapes are key:type pairs. Throws otherwise.
 */
export function assertShapeDocumentSafe(doc: unknown): asserts doc is ShapeDocument {
  const d = onlyKeys(doc, KEYS.document, "document");
  if (d.schema !== SHAPE_SCHEMA) throw new Error("contribution: unknown schema");
  if (typeof d.contributor !== "string" || !/^c_[0-9a-f]{16}$/.test(d.contributor))
    throw new Error("contribution: contributor must be a c_ id");
  const consent = onlyKeys(d.consent, KEYS.consent, "consent");
  if (typeof consent.termsVersion !== "string" || typeof consent.acceptedAt !== "string")
    throw new Error("contribution: consent must carry termsVersion and acceptedAt");
  const client = onlyKeys(d.client, KEYS.client, "client");
  if (
    client.name !== "sayagain" ||
    typeof client.version !== "string" ||
    typeof client.source !== "string"
  )
    throw new Error("contribution: client must be sayagain with a version and a source");
  const window = onlyKeys(d.window, KEYS.window, "window");
  if (
    Number.isNaN(Date.parse(String(window.since))) ||
    Number.isNaN(Date.parse(String(window.until)))
  )
    throw new Error("contribution: window must be two dates");
  count(d.sessions, "sessions");
  if (!Array.isArray(d.shapes)) throw new Error("contribution: shapes must be a list");
  for (const [i, s] of d.shapes.entries()) assertShapeSafe(s, `shapes[${i}]`);
}

export const contributionsDir = (): string => homePath("contributions");

/** Write the document before anything else happens to it (0600, atomic). Returns the path. */
export function writeContribution(doc: ShapeDocument, now: Date = new Date()): string {
  const dir = contributionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // the directory is 0700
  }
  return path;
}

export const newContributorId = (): string => `c_${randomBytes(8).toString("hex")}`;

/** The settings block, creating the contributor id on first use (saved when `save` is true). */
export function contributeSettings(registry: Registry, save = true): ContributeSettings {
  if (!registry.contribute) registry.contribute = {};
  if (!registry.contribute.contributor) {
    registry.contribute.contributor = newContributorId();
    if (save) saveRegistry(registry);
  }
  return registry.contribute;
}

export function summarizeDocument(doc: ShapeDocument): string {
  const servers = new Set(doc.shapes.map((s) => s.server)).size;
  const errors = doc.shapes.reduce((a, s) => a + s.errors.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(doc.shapes.length, "shape")} across ${plural(servers, "server")}, ${plural(errors, "error signature")}, ${plural(doc.sessions, "session")}, ${doc.window.since.slice(0, 10)} to ${doc.window.until.slice(0, 10)}, source ${doc.client.source}`;
}

/** Only HTTPS leaves the machine; plain HTTP is for a loopback endpoint under test. */
export function checkEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`contribute: ${JSON.stringify(endpoint)} is not a URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("contribute: the endpoint must be https (http only for a loopback endpoint)");
  return url;
}

export interface Receipt {
  status: number;
  receipt?: string;
  url?: string;
}

type Fetch = typeof fetch;

/** POST the document; the reply is a receipt and a link to the contributor's servers on the index. */
export async function sendContribution(
  doc: ShapeDocument,
  endpoint: string,
  version: string,
  fetchImpl: Fetch = fetch,
): Promise<Receipt> {
  assertShapeDocumentSafe(doc);
  const url = checkEndpoint(endpoint);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${doc.contributor}`,
      "user-agent": `sayagain/${version}`,
    },
    body: JSON.stringify(doc),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`contribute: the index answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { receipt?: unknown; url?: unknown };
  return {
    status: res.status,
    ...(typeof body.receipt === "string" ? { receipt: body.receipt } : {}),
    ...(typeof body.url === "string" ? { url: body.url } : {}),
  };
}

/** DELETE everything the index holds for this contributor. */
export async function forgetContributor(
  contributor: string,
  endpoint: string,
  version: string,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  const url = checkEndpoint(endpoint);
  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${contributor}`, "user-agent": `sayagain/${version}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`contribute: the index answered ${res.status}`);
  return res.status;
}

export const WEEK_MS = 7 * 86_400_000;

export interface WeeklyOptions {
  rows: LedgerRow[];
  version: string;
  now?: Date;
  fetchImpl?: Fetch;
  registry?: Registry;
  log?: (line: string) => void;
}

export interface WeeklyOutcome {
  sent: boolean;
  reason: string;
  path?: string;
  receipt?: Receipt;
}

/**
 * The daemon's weekly contribution: runs only with `weekly` on, an endpoint, the current terms
 * accepted, and a week since the last one; `SAYAGAIN_CONTRIBUTE=0` stops it. Nothing is sent
 * otherwise. Returns what happened, for the log and the tests.
 */
export async function weeklyContribution(opts: WeeklyOptions): Promise<WeeklyOutcome> {
  if (process.env.SAYAGAIN_CONTRIBUTE === "0")
    return { sent: false, reason: "SAYAGAIN_CONTRIBUTE=0" };
  const registry = opts.registry ?? loadRegistry();
  const c = registry.contribute;
  if (!c?.weekly) return { sent: false, reason: "weekly contribution is off" };
  if (!c.endpoint) return { sent: false, reason: "no endpoint" };
  if (c.consent?.termsVersion !== TERMS_VERSION)
    return { sent: false, reason: "terms not accepted" };
  const now = opts.now ?? new Date();
  const last = c.lastSentAt ? Date.parse(c.lastSentAt) : 0;
  if (now.getTime() - last < WEEK_MS) return { sent: false, reason: "sent within the week" };
  const since = new Date(Math.max(last, now.getTime() - WEEK_MS));
  const doc = buildShapeDocument(opts.rows, {
    source: "ledger",
    contributor: contributeSettings(registry).contributor as string,
    consent: c.consent,
    since,
    until: now,
    version: opts.version,
  });
  if (!doc.shapes.length) return { sent: false, reason: "nothing to contribute" };
  const path = writeContribution(doc, now);
  const receipt = await sendContribution(doc, c.endpoint, opts.version, opts.fetchImpl);
  c.lastSentAt = now.toISOString();
  saveRegistry(registry);
  opts.log?.(`contributed ${summarizeDocument(doc)} (${path})`);
  return { sent: true, reason: "sent", path, receipt };
}
