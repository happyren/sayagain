/**
 * Onboarding: import a host's MCP servers into the registry, rewrite the
 * host's entries to go through the boundary (keeping each key, so the agent
 * still sees "notion"), install entries for registered servers, and eject
 * back to the originals. Every write backs the file up first and is atomic.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, type HostId, type HostSpec, type Scope } from "./hosts.js";
import { detectIndent, parseJsonc } from "./jsonc.js";
import {
  loadOrCreateToken,
  loadRegistry,
  type Registry,
  type ServerConfig,
  saveRegistry,
} from "./registry.js";

export type HostEntry = Record<string, unknown>;

export interface Target {
  host: HostId;
  file: string;
  scope: Scope;
}

export interface WriteOptions {
  dryRun: boolean;
  log: (line: string) => void;
}

export interface EntryOptions {
  transport: "stdio" | "http";
  /** The command to write for stdio entries; default: `sayagain` on PATH for terminal hosts, absolute for GUI hosts. */
  command?: string;
}

export interface ImportOptions extends WriteOptions, EntryOptions {
  rewrite: boolean;
  /** Replace a registered server whose config differs. */
  force: boolean;
}

export interface ImportResult {
  file: string;
  imported: string[];
  updated: string[];
  unchanged: string[];
  skipped: { name: string; reason: string }[];
  rewritten: string[];
  backup?: string;
}

export interface InstallResult {
  file: string;
  added: string[];
  rewritten: string[];
  unchanged: string[];
  backup?: string;
}

export interface EjectResult {
  file: string;
  restored: string[];
  removed: string[];
  unregistered: string[];
  backup?: string;
}

// ---------------------------------------------------------------- reading and writing host files

interface HostDocument {
  root: Record<string, unknown>;
  servers: Record<string, HostEntry>;
  text: string;
  indent: string;
  hadComments: boolean;
  existed: boolean;
}

export function readHostFile(spec: HostSpec, file: string): HostDocument {
  if (!existsSync(file))
    return { root: {}, servers: {}, text: "", indent: "  ", hadComments: false, existed: false };
  const text = readFileSync(file, "utf8");
  const parsed = text.trim() ? parseJsonc(text) : { value: {}, hadComments: false };
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value))
    throw new Error(`${file}: expected a JSON object at the top level`);
  const root = parsed.value as Record<string, unknown>;
  const raw = root[spec.key];
  const servers: Record<string, HostEntry> = {};
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error(`${file}: "${spec.key}" is not an object`);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === "object" && v !== null && !Array.isArray(v)) servers[k] = v as HostEntry;
  }
  return {
    root,
    servers,
    text,
    indent: detectIndent(text),
    hadComments: parsed.hadComments,
    existed: true,
  };
}

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** Back the file up beside itself, then write atomically. Returns the backup path (undefined when the file was new). */
export function writeHostFile(
  spec: HostSpec,
  file: string,
  doc: HostDocument,
  servers: Record<string, HostEntry>,
  opts: WriteOptions,
): string | undefined {
  const root = { ...doc.root, [spec.key]: servers };
  const text = `${JSON.stringify(root, null, doc.indent)}\n`;
  if (opts.dryRun) {
    opts.log(`[dry-run] would write ${file}`);
    return undefined;
  }
  let backup: string | undefined;
  if (doc.existed) {
    backup = `${file}.sayagain-backup-${stamp()}`;
    copyFileSync(file, backup);
    if (doc.hadComments)
      opts.log(
        `note: ${basename(file)} had comments; they are not preserved (the original is in ${basename(backup)})`,
      );
  } else mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return backup;
}

// ---------------------------------------------------------------- entries

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const names = process.platform === "win32" ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
  return dirs.some((d) => names.some((n) => existsSync(resolve(d, n))));
}

/** The host entry that routes `name` through the boundary. */
export function boundaryEntry(
  spec: HostSpec,
  name: string,
  opts: EntryOptions,
  registry: Registry,
): HostEntry {
  if (opts.transport === "http") {
    if (!spec.http)
      throw new Error(`${spec.label} does not accept HTTP entries; use --transport stdio`);
    const listen = registry.daemon?.listen ?? "127.0.0.1:7777";
    const at = listen.lastIndexOf(":");
    const host = listen.slice(0, at) || "127.0.0.1";
    const port = listen.slice(at + 1) || "7777";
    return {
      type: "http",
      url: `http://${host}:${port}/mcp/${name}`,
      headers: { Authorization: `Bearer ${loadOrCreateToken()}` },
    };
  }
  let command: string;
  let args: string[];
  if (opts.command) {
    command = opts.command;
    args = ["stdio", name];
  } else if (!spec.gui && onPath("sayagain")) {
    command = "sayagain";
    args = ["stdio", name];
  } else {
    command = process.execPath;
    args = [CLI_PATH, "stdio", name];
  }
  const entry: HostEntry = spec.typed ? { type: "stdio", command, args } : { command, args };
  return entry;
}

/** Does this host entry already go through Say Again? */
export function isBoundaryEntry(entry: HostEntry): boolean {
  const command = typeof entry.command === "string" ? basename(entry.command) : "";
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const stdioAt = args.indexOf("stdio");
  if (stdioAt >= 0) {
    if (/^sayagain(\.js|\.cmd|\.exe)?$/.test(command)) return true;
    const before = args[stdioAt - 1] ?? "";
    if (/(^|[\\/])(cli|sayagain)\.js$/.test(before)) return true;
  }
  if (
    typeof entry.url === "string" &&
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/mcp\/[^/]+\/?$/.test(entry.url)
  )
    return true;
  return false;
}

/** Translate a host entry into a registry config, or explain why it cannot be. */
export function configFromEntry(entry: HostEntry): { config: ServerConfig } | { reason: string } {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const text = JSON.stringify(entry);
  if (text.includes("${input:"))
    return { reason: "uses VS Code input variables; register it by hand with --env or --header" };
  if (type === "sse")
    return { reason: "legacy SSE transport; the boundary speaks Streamable HTTP" };
  if (type === "http" || (type === undefined && typeof entry.url === "string")) {
    if (typeof entry.url !== "string") return { reason: "http entry without a url" };
    const config: ServerConfig = { transport: "http", url: entry.url };
    const headers = entry.headers;
    if (typeof headers === "object" && headers !== null && !Array.isArray(headers))
      config.headers = stringMap(headers as Record<string, unknown>);
    return { config };
  }
  if (type === "stdio" || (type === undefined && typeof entry.command === "string")) {
    if (typeof entry.command !== "string") return { reason: "stdio entry without a command" };
    const config: ServerConfig = {
      transport: "stdio",
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    };
    const env = entry.env;
    if (typeof env === "object" && env !== null && !Array.isArray(env))
      config.env = stringMap(env as Record<string, unknown>);
    if (typeof entry.cwd === "string") config.cwd = entry.cwd;
    return { config };
  }
  return { reason: `unrecognised entry${type ? ` (type ${type})` : ""}` };
}

const stringMap = (o: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

const sameConfig = (a: ServerConfig, b: ServerConfig): boolean => {
  const strip = (c: ServerConfig) => {
    const { origins: _o, ...rest } = c;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
};

// ---------------------------------------------------------------- import / install / eject

export function importHost(target: Target, opts: ImportOptions): ImportResult {
  const spec = HOSTS[target.host];
  const doc = readHostFile(spec, target.file);
  const registry = loadRegistry();
  const result: ImportResult = {
    file: target.file,
    imported: [],
    updated: [],
    unchanged: [],
    skipped: [],
    rewritten: [],
  };
  const next: Record<string, HostEntry> = { ...doc.servers };
  let registryChanged = false;
  for (const [name, entry] of Object.entries(doc.servers)) {
    if (isBoundaryEntry(entry)) {
      result.skipped.push({ name, reason: "already goes through Say Again" });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      result.skipped.push({ name, reason: "name has characters the registry does not accept" });
      continue;
    }
    const translated = configFromEntry(entry);
    if ("reason" in translated) {
      result.skipped.push({ name, reason: translated.reason });
      continue;
    }
    const existing = registry.servers[name];
    const origins = { ...(existing?.origins ?? {}), [target.file]: { host: target.host, entry } };
    const config: ServerConfig = { ...translated.config, origins };
    if (existing && !sameConfig(existing, config)) {
      if (!opts.force) {
        result.skipped.push({
          name,
          reason: `already registered with a different command or url (use --force to replace)`,
        });
        continue;
      }
      result.updated.push(name);
    } else if (existing) result.unchanged.push(name);
    else result.imported.push(name);
    if (
      !existing ||
      !sameConfig(existing, config) ||
      JSON.stringify(existing.origins ?? {}) !== JSON.stringify(origins)
    ) {
      registry.servers[name] = config;
      registryChanged = true;
    }
    if (opts.rewrite) {
      next[name] = boundaryEntry(spec, name, opts, registry);
      result.rewritten.push(name);
    }
  }
  if (registryChanged && !opts.dryRun) saveRegistry(registry);
  if (result.rewritten.length) {
    const backup = writeHostFile(spec, target.file, doc, next, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/** Write boundary entries for registered servers into a host file: new keys, and keys that point elsewhere. */
export function installHost(
  target: Target,
  names: string[] | undefined,
  opts: WriteOptions & EntryOptions,
): InstallResult {
  const spec = HOSTS[target.host];
  const doc = readHostFile(spec, target.file);
  const registry = loadRegistry();
  const wanted = names ?? Object.keys(registry.servers);
  const result: InstallResult = { file: target.file, added: [], rewritten: [], unchanged: [] };
  const next: Record<string, HostEntry> = { ...doc.servers };
  for (const name of wanted) {
    if (!registry.servers[name]) throw new Error(`no registered server named ${name}`);
    const current = doc.servers[name];
    const entry = boundaryEntry(spec, name, opts, registry);
    if (current && isBoundaryEntry(current) && JSON.stringify(current) === JSON.stringify(entry)) {
      result.unchanged.push(name);
      continue;
    }
    if (current && !isBoundaryEntry(current)) {
      const cfg = registry.servers[name] as ServerConfig;
      cfg.origins = {
        ...(cfg.origins ?? {}),
        [target.file]: { host: target.host, entry: current },
      };
      result.rewritten.push(name);
    } else if (current) result.rewritten.push(name);
    else result.added.push(name);
    next[name] = entry;
  }
  if (result.added.length || result.rewritten.length) {
    if (!opts.dryRun) saveRegistry(registry);
    const backup = writeHostFile(spec, target.file, doc, next, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/** Put the host's original entries back and forget them in the registry (unless kept). */
export function ejectHost(
  target: Target,
  names: string[] | undefined,
  opts: WriteOptions & { keep: boolean },
): EjectResult {
  const spec = HOSTS[target.host];
  const doc = readHostFile(spec, target.file);
  const registry = loadRegistry();
  const result: EjectResult = { file: target.file, restored: [], removed: [], unregistered: [] };
  const next: Record<string, HostEntry> = { ...doc.servers };
  let registryChanged = false;
  for (const [name, entry] of Object.entries(doc.servers)) {
    if (names && !names.includes(name)) continue;
    if (!isBoundaryEntry(entry)) continue;
    const cfg = registry.servers[name];
    const origin = cfg?.origins?.[target.file];
    if (origin) {
      next[name] = origin.entry as HostEntry;
      result.restored.push(name);
      if (cfg) {
        const { [target.file]: _gone, ...rest } = cfg.origins ?? {};
        if (Object.keys(rest).length) cfg.origins = rest;
        else delete cfg.origins;
        registryChanged = true;
      }
    } else {
      // Installed from the registry rather than imported: nothing to restore, so the entry goes.
      delete next[name];
      result.removed.push(name);
    }
    if (cfg && !opts.keep && !cfg.origins && cfg.imported !== false && origin) {
      delete registry.servers[name];
      result.unregistered.push(name);
      registryChanged = true;
    }
  }
  if (registryChanged && !opts.dryRun) saveRegistry(registry);
  if (result.restored.length || result.removed.length) {
    const backup = writeHostFile(spec, target.file, doc, next, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/** What a host file holds: how many servers, how many already wrapped. */
export function inspectHost(target: Target): { servers: string[]; wrapped: string[] } {
  const doc = readHostFile(HOSTS[target.host], target.file);
  const servers = Object.keys(doc.servers);
  return { servers, wrapped: servers.filter((n) => isBoundaryEntry(doc.servers[n] as HostEntry)) };
}
