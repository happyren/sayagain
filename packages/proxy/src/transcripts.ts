/**
 * Transcript readers for `sayagain audit` and `sayagain contribute` (Phase 0 of docs/ROADMAP.md).
 * Claude Code, Codex and Cursor session files become ledger rows, so the 0.6 analysis runs over
 * history the boundary never saw. Only tool names, argument shapes and hashes, masked error
 * signatures, token counts and timestamps leave a reader; argument values, results and prompts
 * are read and dropped in memory (ADR-0005).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ToolClass } from "@sayagain/sdk";
import { hashArgs, shapeOf } from "./boundary.js";
import { classifyError, type ErrorClass } from "./errors.js";
import type { LedgerRow } from "./ledger.js";
import { signatureOf } from "./signature.js";

export type TranscriptSource = "claude-code" | "codex" | "cursor";
export const TRANSCRIPT_SOURCES: readonly TranscriptSource[] = ["claude-code", "codex", "cursor"];
export const isTranscriptSource = (s: string): s is TranscriptSource =>
  (TRANSCRIPT_SOURCES as readonly string[]).includes(s);

export type ModelFamily = "claude" | "gpt" | "gemini" | "open-weight" | "unknown";
export type Outcome = "ok" | "error" | "interrupt" | "no-result" | "unrecorded";
export type ClassSource = "builtin" | "verb" | "default";

export interface TranscriptCall {
  /** When the call was issued, ms since the epoch. */
  ts: number;
  tool: string;
  /** The MCP server's name; the host's own name for its built-in tools. */
  server: string;
  isMcp: boolean;
  toolClass: ToolClass;
  classSource: ClassSource;
  argShape: string[];
  argsHash: string;
  outcome: Outcome;
  errorClass?: ErrorClass;
  signature?: string;
  /** Request to result; NaN when the file does not say. */
  latencyMs: number;
  /** Model tokens of the turn that issued the call (a turn with several calls splits them). */
  tokens: number;
  usd: number;
  model: string;
  /** SHA-256 of the tool's input schema, first 16 hex, when the file carries the schema. */
  schemaHash?: string;
}

export interface TranscriptSession {
  /** A local key: SHA-256 of the file path, first 12 hex. The path itself is not kept. */
  id: string;
  source: TranscriptSource;
  calls: TranscriptCall[];
  tokens: { input: number; cacheRead: number; cacheCreate: number; output: number };
  usd: number;
  /** Calls per model family. */
  families: Record<string, number>;
  minTs: number;
  maxTs: number;
  /** The file records tool results (Cursor files may not; their outcomes are then unrecorded). */
  resultsRecorded: boolean;
}

/** USD per million tokens (input, output) at list price. Cache reads cost 10% of input, cache creation 125%. */
const PRICES: [string, number, number][] = [
  ["fable-5", 10, 50],
  ["opus-5", 5, 25],
  ["sonnet-5", 2, 10],
  ["haiku-4-5", 1, 5],
  ["opus-4", 15, 75],
  ["sonnet-4", 3, 15],
  ["gpt-5-mini", 0.25, 2],
  ["gpt-5-nano", 0.05, 0.4],
  ["gpt-5", 1.25, 10],
  ["o4-mini", 1.1, 4.4],
  ["o3", 2, 8],
  ["gemini-2.5-flash", 0.3, 2.5],
  ["gemini-2.5-pro", 1.25, 10],
];
export const priceFor = (model = ""): [string, number, number] =>
  PRICES.find(([k]) => model.includes(k)) ?? ["default", 5, 25];

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (!m) return "unknown";
  if (/claude|fable|opus|sonnet|haiku/.test(m)) return "claude";
  if (/gpt|^o[134]\b|^o[134]-|codex/.test(m)) return "gpt";
  if (/gemini/.test(m)) return "gemini";
  if (/llama|qwen|mistral|mixtral|deepseek|gemma|phi-|glm|kimi/.test(m)) return "open-weight";
  return "unknown";
}

const usdOf = (
  model: string,
  t: { input: number; cacheRead: number; cacheCreate: number; output: number },
): number => {
  const [, pin, pout] = priceFor(model);
  return (
    (t.input * pin + t.cacheRead * pin * 0.1 + t.cacheCreate * pin * 1.25 + t.output * pout) / 1e6
  );
};

// Built-in tools of each host. Anything else built in is host-internal and counted read-only.
const BUILTIN_READ = new Set([
  // Claude Code
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "ToolSearch",
  // Codex
  "read_thread_terminal",
  "load_workspace_dependencies",
  "list_mcp_resources",
  "read_mcp_resource",
  "view_image",
  // Cursor
  "read_file",
  "list_dir",
  "grep",
  "grep_search",
  "codebase_search",
  "glob_file_search",
  "file_search",
  "web_search",
  "read_lints",
  "fetch_rules",
]);
const BUILTIN_WRITE = new Set([
  // Claude Code
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  // Codex
  "exec_command",
  "write_stdin",
  "apply_patch",
  "shell",
  "shell_command",
  // Cursor
  "edit_file",
  "search_replace",
  "write",
  "run_terminal_cmd",
  "delete_file",
  "reapply",
]);
const READ_VERBS =
  /^(get|list|search|read|find|fetch|query|describe|show|view|check|status|count|lookup|whoami|inspect|browse|preview|resolve|validate|explain)/i;
const WRITE_VERBS =
  /^(create|update|delete|send|post|write|set|add|remove|edit|push|merge|publish|upload|insert|put|patch|replace|move|rename|execute|run|trigger|cancel|archive|trash|start|stop|restart|kill|deploy|apply|approve|reject|submit|reply|save|import|export|invite|assign|close|open|drop|purge)/i;
const DESTRUCTIVE_VERBS = /^(delete|remove|trash|drop|purge|destroy|kill|wipe|reset)/i;

/** The class the boundary would give the tool: annotations are not in a transcript, so verbs decide. */
export function toolClassFor(
  tool: string,
  isMcp: boolean,
): { toolClass: ToolClass; classSource: ClassSource } {
  if (!isMcp) {
    if (BUILTIN_READ.has(tool)) return { toolClass: "read-only", classSource: "builtin" };
    if (BUILTIN_WRITE.has(tool)) return { toolClass: "write", classSource: "builtin" };
    return { toolClass: "read-only", classSource: "default" };
  }
  const verb = tool.split("__").pop() ?? tool;
  if (DESTRUCTIVE_VERBS.test(verb)) return { toolClass: "destructive", classSource: "verb" };
  if (READ_VERBS.test(verb)) return { toolClass: "read-only", classSource: "verb" };
  if (WRITE_VERBS.test(verb)) return { toolClass: "write", classSource: "verb" };
  // The boundary's own rule for a tool without annotations: a write, held by default.
  return { toolClass: "write", classSource: "default" };
}

const INTERRUPT =
  /interrupted by user|request interrupted|user cancel|user doesn't want|tool use was rejected|wait for the user|aborted by user|cancelled by user/i;

/** Outcome of a recorded result: the interrupt check comes first, as in the baseline analyzer. */
function outcomeOf(
  isError: boolean,
  text: string,
): { outcome: Outcome; errorClass?: ErrorClass; signature?: string } {
  if (!isError) return { outcome: "ok" };
  if (INTERRUPT.test(text)) return { outcome: "interrupt" };
  return { outcome: "error", errorClass: classifyError(text), signature: signatureOf(text) };
}

/** A server named by a UUID or a long hex id is someone's private connector, not a public server. */
export const OPAQUE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{20,}$/i;
/** What an opaque server name becomes in every output, so the id itself never leaves the file. */
export const PRIVATE_CONNECTOR = "private-connector";
export const publicServerName = (name: string): string =>
  OPAQUE_NAME.test(name) ? PRIVATE_CONNECTOR : name;

/** `mcp__server__tool` (Claude Code), `mcp_server_tool` (Cursor) or a plain built-in name. */
function splitToolName(
  name: string,
  host: TranscriptSource,
): { server: string; tool: string; isMcp: boolean } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return {
      server: publicServerName(parts[1] ?? "mcp"),
      tool: parts.slice(2).join("__") || name,
      isMcp: true,
    };
  }
  if (name.startsWith("mcp_")) {
    const rest = name.slice(4);
    const i = rest.indexOf("_");
    if (i > 0)
      return { server: publicServerName(rest.slice(0, i)), tool: rest.slice(i + 1), isMcp: true };
  }
  return { server: host, tool: name, isMcp: false };
}

export const schemaHashOf = (schema: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(schema ?? null))
    .digest("hex")
    .slice(0, 16);

const sessionId = (file: string): string =>
  createHash("sha256").update(resolve(file)).digest("hex").slice(0, 12);

const parseTs = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

/** Tokens of the turn that issued each call, split across the turn's calls; text-only turns carry forward. */
interface Turn {
  tokens: number;
  usd: number;
  model: string;
  calls: TranscriptCall[];
}
function attributeTurns(turns: Turn[], calls: TranscriptCall[]): void {
  let carryTokens = 0;
  let carryUsd = 0;
  let model = "";
  for (const t of turns) {
    if (t.model) model = t.model;
    if (!t.calls.length) {
      carryTokens += t.tokens;
      carryUsd += t.usd;
      continue;
    }
    const n = t.calls.length;
    for (const c of t.calls) {
      c.tokens = (carryTokens + t.tokens) / n;
      c.usd = (carryUsd + t.usd) / n;
      c.model = t.model || model;
    }
    carryTokens = 0;
    carryUsd = 0;
  }
  // Turns after the last call (the wrap-up) belong to the last call, so a session's spend adds up.
  const last = calls[calls.length - 1];
  if (last && (carryTokens || carryUsd)) {
    last.tokens += carryTokens;
    last.usd += carryUsd;
  }
}

function finishSession(
  s: TranscriptSession,
  pending: Map<string, TranscriptCall>,
  turns: Turn[],
): TranscriptSession {
  for (const c of pending.values()) c.outcome = s.resultsRecorded ? "no-result" : "unrecorded";
  attributeTurns(turns, s.calls);
  for (const c of s.calls) {
    if (Number.isFinite(c.ts)) {
      if (c.ts < s.minTs) s.minTs = c.ts;
      if (c.ts > s.maxTs) s.maxTs = c.ts;
    }
    const f = modelFamily(c.model);
    s.families[f] = (s.families[f] ?? 0) + 1;
  }
  return s;
}

const newSession = (file: string, source: TranscriptSource): TranscriptSession => ({
  id: sessionId(file),
  source,
  calls: [],
  tokens: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 },
  usd: 0,
  families: {},
  minTs: Number.POSITIVE_INFINITY,
  maxTs: 0,
  resultsRecorded: false,
});

const newCall = (
  ts: number,
  name: string,
  input: unknown,
  host: TranscriptSource,
  model: string,
): TranscriptCall => {
  const { server, tool, isMcp } = splitToolName(name, host);
  return {
    ts,
    tool,
    server,
    isMcp,
    ...toolClassFor(tool, isMcp),
    argShape: shapeOf(input),
    argsHash: hashArgs(input),
    outcome: "unrecorded",
    latencyMs: Number.NaN,
    tokens: 0,
    usd: 0,
    model,
  };
};

function readLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn line is not a reason to drop the session
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Text of a tool result block, plus the host's own error fields, for classification only. */
function blockText(block: Obj, top: Obj | undefined): string {
  const parts: string[] = [];
  const c = block.content;
  if (typeof c === "string") parts.push(c);
  else if (Array.isArray(c))
    for (const b of c)
      if (obj(b) && typeof obj(b)?.text === "string") parts.push(str(obj(b)?.text));
  if (top)
    for (const k of ["stderr", "error", "message"])
      if (typeof top[k] === "string") parts.push(str(top[k]));
  return parts.join("\n").slice(0, 4000);
}

/**
 * Anthropic-style message lines: Claude Code (`type`, `message`, `requestId`, `timestamp`,
 * `toolUseResult`) and Cursor (`role`, `message`, no usage). One reader serves both.
 */
function readMessageSession(file: string, source: "claude-code" | "cursor"): TranscriptSession {
  const s = newSession(file, source);
  const pending = new Map<string, TranscriptCall>();
  const turns: Turn[] = [];
  const turnByRequest = new Map<string, Turn>();
  let fallbackTs = (() => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  for (const raw of readLines(file)) {
    const e = obj(raw);
    if (!e) continue;
    const m = obj(e.message);
    if (!m) continue;
    const role = str(e.type) || str(e.role) || str(m.role);
    let ts = parseTs(e.timestamp);
    if (!Number.isFinite(ts)) ts = fallbackTs++;
    if (role === "assistant") {
      const requestId = str(e.requestId);
      let turn = requestId ? turnByRequest.get(requestId) : undefined;
      if (!turn) {
        turn = { tokens: 0, usd: 0, model: str(m.model), calls: [] };
        const u = obj(m.usage);
        if (u) {
          const t = {
            input: num(u.input_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheCreate: num(u.cache_creation_input_tokens),
            output: num(u.output_tokens),
          };
          turn.tokens = t.input + t.cacheRead + t.cacheCreate + t.output;
          turn.usd = usdOf(turn.model, t);
          s.tokens.input += t.input;
          s.tokens.cacheRead += t.cacheRead;
          s.tokens.cacheCreate += t.cacheCreate;
          s.tokens.output += t.output;
          s.usd += turn.usd;
        }
        turns.push(turn);
        if (requestId) turnByRequest.set(requestId, turn);
      }
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        const block = obj(b);
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const call = newCall(ts, block.name, block.input, source, turn.model);
        s.calls.push(call);
        turn.calls.push(call);
        if (typeof block.id === "string") pending.set(block.id, call);
      }
    } else if (role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        const block = obj(b);
        if (block?.type !== "tool_result") continue;
        s.resultsRecorded = true;
        const call =
          typeof block.tool_use_id === "string" ? pending.get(block.tool_use_id) : undefined;
        if (!call) continue;
        pending.delete(str(block.tool_use_id));
        const text = blockText(block, obj(e.toolUseResult));
        Object.assign(call, outcomeOf(block.is_error === true, text));
        call.latencyMs =
          Number.isFinite(ts) && Number.isFinite(call.ts) ? Math.max(0, ts - call.ts) : Number.NaN;
      }
    }
  }
  return finishSession(s, pending, turns);
}

const CODEX_FAILED =
  /Process exited with code [1-9]\d*|^Exit code: [1-9]\d*|^[\w-]+ failed:|verification failed|^Error\b|^error:/im;

/** Codex CLI rollouts: `response_item`, `event_msg` and `turn_context` lines under ~/.codex/sessions. */
function readCodexSession(file: string): TranscriptSession {
  const s = newSession(file, "codex");
  const pending = new Map<string, TranscriptCall>();
  const turns: Turn[] = [];
  const schemas = new Map<string, string>();
  let model = "";
  let open: Turn = { tokens: 0, usd: 0, model, calls: [] };
  turns.push(open);
  for (const raw of readLines(file)) {
    const e = obj(raw);
    const p = obj(e?.payload);
    if (!e || !p) continue;
    const ts = parseTs(e.timestamp);
    const type = str(e.type);
    if (type === "session_meta") {
      const tools = Array.isArray(p.dynamic_tools) ? p.dynamic_tools : [];
      for (const t of tools) {
        const tool = obj(t);
        if (!tool || typeof tool.name !== "string" || tool.inputSchema === undefined) continue;
        const key =
          typeof tool.namespace === "string" ? `${tool.namespace}/${tool.name}` : tool.name;
        schemas.set(key, schemaHashOf(tool.inputSchema));
      }
    } else if (type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
    } else if (
      type === "response_item" &&
      (p.type === "function_call" || p.type === "custom_tool_call")
    ) {
      let input: unknown;
      const rawArgs = p.type === "function_call" ? p.arguments : p.input;
      if (typeof rawArgs === "string") {
        try {
          input = JSON.parse(rawArgs);
        } catch {
          input = { input: rawArgs };
        }
      } else input = rawArgs;
      const call = newCall(ts, str(p.name), input, "codex", model);
      s.calls.push(call);
      open.calls.push(call);
      if (typeof p.call_id === "string") pending.set(p.call_id, call);
    } else if (
      type === "response_item" &&
      (p.type === "function_call_output" || p.type === "custom_tool_call_output")
    ) {
      s.resultsRecorded = true;
      const call = typeof p.call_id === "string" ? pending.get(p.call_id) : undefined;
      if (!call) continue;
      pending.delete(str(p.call_id));
      let text = str(p.output).slice(0, 4000);
      let failed = CODEX_FAILED.test(text) || INTERRUPT.test(text);
      // exec_command wraps the command's output in a header (chunk id, wall time, exit code).
      const body = text.match(/(?:^|\n)Output:\n([\s\S]*)$/);
      if (body?.[1] !== undefined) text = body[1].slice(0, 4000);
      if (text.startsWith("{")) {
        try {
          const o = obj(JSON.parse(text));
          const meta = obj(o?.metadata);
          if (meta && num(meta.exit_code) !== 0) failed = true;
          if (o && typeof o.output === "string") text = o.output.slice(0, 4000);
        } catch {
          // plain text after all
        }
      }
      Object.assign(call, outcomeOf(failed, text));
      call.latencyMs =
        Number.isFinite(ts) && Number.isFinite(call.ts) ? Math.max(0, ts - call.ts) : Number.NaN;
    } else if (type === "event_msg" && p.type === "mcp_tool_call_end") {
      s.resultsRecorded = true;
      const inv = obj(p.invocation);
      if (!inv) continue;
      const server = publicServerName(str(inv.server) || "mcp");
      const tool = str(inv.tool);
      const call = newCall(ts, tool, inv.arguments, "codex", model);
      call.server = server;
      call.isMcp = true;
      Object.assign(call, toolClassFor(tool, true));
      const schema = schemas.get(`${server}/${tool}`);
      if (schema) call.schemaHash = schema;
      const d = obj(p.duration);
      if (d) call.latencyMs = num(d.secs) * 1000 + num(d.nanos) / 1e6;
      const result = obj(p.result);
      const ok = obj(result?.Ok);
      const text = ok
        ? blockText(ok, undefined)
        : str(result?.Err) || JSON.stringify(result?.Err ?? "");
      Object.assign(call, outcomeOf(!ok || ok.isError === true, text));
      s.calls.push(call);
      open.calls.push(call);
    } else if (type === "event_msg" && p.type === "token_count") {
      const info = obj(p.info);
      const last = obj(info?.last_token_usage);
      if (!last) continue;
      const input = num(last.input_tokens);
      const cached = Math.min(input, num(last.cached_input_tokens));
      const t = {
        input: input - cached,
        cacheRead: cached,
        cacheCreate: 0,
        output: num(last.output_tokens),
      };
      open.model = model;
      open.tokens = t.input + t.cacheRead + t.output;
      open.usd = usdOf(model, t);
      s.tokens.input += t.input;
      s.tokens.cacheRead += t.cacheRead;
      s.tokens.output += t.output;
      s.usd += open.usd;
      open = { tokens: 0, usd: 0, model, calls: [] };
      turns.push(open);
    }
  }
  return finishSession(s, pending, turns);
}

export function readSession(file: string, source: TranscriptSource): TranscriptSession {
  return source === "codex" ? readCodexSession(file) : readMessageSession(file, source);
}

/** Where each host keeps its transcripts, honouring the hosts' own environment variables. */
export function defaultTranscriptDirs(): Record<TranscriptSource, string> {
  return {
    "claude-code": join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    cursor: join(homedir(), ".cursor", "projects"),
  };
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    const p = join(dir, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p, depth + 1);
    else if (f.endsWith(".jsonl")) yield p;
  }
}

/** Cursor keeps transcripts under `<project>/agent-transcripts/`; other files in ~/.cursor/projects are not sessions. */
const isSessionFile = (file: string, source: TranscriptSource): boolean =>
  source !== "cursor" || file.split(sep).includes("agent-transcripts");

export interface ScanOptions {
  sources?: TranscriptSource[];
  /** Overrides per source; a missing directory is skipped, not an error. */
  dirs?: Partial<Record<TranscriptSource, string>>;
  /** Files last modified before this are skipped. */
  since?: Date;
}

export interface Scan {
  sessions: TranscriptSession[];
  files: Record<TranscriptSource, number>;
  dirs: Record<TranscriptSource, string>;
}

export function scanTranscripts(opts: ScanOptions = {}): Scan {
  const dirs = { ...defaultTranscriptDirs(), ...(opts.dirs ?? {}) };
  const sources = opts.sources ?? [...TRANSCRIPT_SOURCES];
  const files: Record<TranscriptSource, number> = { "claude-code": 0, codex: 0, cursor: 0 };
  const sessions: TranscriptSession[] = [];
  for (const source of sources) {
    const dir = dirs[source];
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (!isSessionFile(file, source)) continue;
      if (opts.since) {
        try {
          if (statSync(file).mtimeMs < opts.since.getTime()) continue;
        } catch {
          continue;
        }
      }
      files[source]++;
      const s = readSession(file, source);
      if (s.calls.length) sessions.push(s);
    }
  }
  return { sessions, files, dirs };
}

/** What a row carries beyond the ledger's fields: the cost unit, the model and the classing. */
export interface RowExtra {
  usd: number;
  tokens: number;
  model: string;
  family: ModelFamily;
  isMcp: boolean;
  classSource: ClassSource;
  source: TranscriptSource;
  outcome: Outcome;
  schemaHash?: string;
}

/**
 * Ledger rows for the analysis. `responseBytes` carries the call's tokens, so the analysis'
 * "bytes" are tokens for transcript rows; an interrupt or a missing result is an error row of
 * class `interrupt` or `no-result` (unknown outcome, not a failure of the tool).
 */
export function sessionRows(s: TranscriptSession): {
  rows: LedgerRow[];
  extras: Map<string, RowExtra>;
} {
  const rows: LedgerRow[] = [];
  const extras = new Map<string, RowExtra>();
  const sorted = [...s.calls].sort((a, b) => a.ts - b.ts);
  sorted.forEach((c, i) => {
    const receipt = `${s.id}:${i}`;
    const row: LedgerRow = {
      receipt,
      ts: new Date(Number.isFinite(c.ts) ? c.ts : s.minTs).toISOString(),
      upstream: c.server,
      server: c.server,
      method: "tools/call",
      tool: c.tool,
      toolClass: c.toolClass,
      argShape: c.argShape,
      argsHash: c.argsHash,
      hasIntent: false,
      session: s.id,
      status: "executed",
      isError: c.outcome === "error" || c.outcome === "interrupt" || c.outcome === "no-result",
      latencyMs: Number.isFinite(c.latencyMs) ? Math.round(c.latencyMs) : 0,
      requestBytes: 0,
      responseBytes: Math.round(c.tokens),
    };
    if (c.outcome === "error") {
      row.errorClass = c.errorClass ?? "other";
      row.errorSignature = c.signature ?? "(no message)";
    } else if (c.outcome === "interrupt") {
      row.errorClass = "interrupt";
      row.errorSignature = "interrupted by the user";
    } else if (c.outcome === "no-result") {
      row.errorClass = "no-result";
      row.errorSignature = "no result recorded";
    }
    rows.push(row);
    extras.set(receipt, {
      usd: c.usd,
      tokens: c.tokens,
      model: c.model,
      family: modelFamily(c.model),
      isMcp: c.isMcp,
      classSource: c.classSource,
      source: s.source,
      outcome: c.outcome,
      ...(c.schemaHash ? { schemaHash: c.schemaHash } : {}),
    });
  });
  return { rows, extras };
}
