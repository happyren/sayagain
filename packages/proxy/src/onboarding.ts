/**
 * Onboarding: import a host's MCP servers into the registry, rewrite the
 * host's entries to go through the boundary (keeping each key, so the agent
 * still sees "notion"), install entries for registered servers, and eject
 * back to the originals. Every write backs the file up first, keeps the
 * file's mode, follows symlinks, and is atomic.
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseListen } from "./daemon.js";
import { homePath } from "./home.js";
import { HOSTS, type HostSpec, projectRootOf, type Target } from "./hosts.js";
import { detectIndent, parseJsonc } from "./jsonc.js";
import { ensureLauncher, launcherPath } from "./launcher.js";
import {
  loadOrCreateToken,
  loadRegistry,
  type Registry,
  type ServerConfig,
  saveRegistry,
  tokenPath,
} from "./registry.js";

export type HostEntry = Record<string, unknown>;
export type { Target } from "./hosts.js";

export interface WriteOptions {
  dryRun: boolean;
  log: (line: string) => void;
}

export interface EntryOptions {
  transport: "stdio" | "http";
  /** The command to write for stdio entries; default: the launcher under the Say Again home. */
  command?: string;
}

export interface ImportOptions extends WriteOptions, EntryOptions {
  rewrite: boolean;
  /** Replace a registered server whose command or url differs. */
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
  left: { name: string; reason: string }[];
  backup?: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = <T>(o: Record<string, T>): [string, T][] =>
  Object.entries(o).filter(([k]) => Object.hasOwn(o, k) && k !== "__proto__");

// ---------------------------------------------------------------- reading and writing host files

interface HostDocument {
  root: Record<string, unknown>;
  /** The server map as found, including entries that are not objects. */
  raw: Record<string, unknown>;
  /** The object-valued entries. */
  servers: Record<string, HostEntry>;
  text: string;
  indent: string;
  hadComments: boolean;
  existed: boolean;
  mode: number;
  /** The file with symlinks resolved; writes go here, and origins are keyed by it. */
  realFile: string;
}

function mapAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const seg of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
  }
  return isPlainObject(node) ? node : undefined;
}

function setAt(
  root: Record<string, unknown>,
  path: string[],
  value: Record<string, unknown>,
): void {
  let node: Record<string, unknown> = root;
  for (const seg of path.slice(0, -1)) {
    const next = node[seg];
    if (!isPlainObject(next)) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
}

export function readHostFile(target: Target): HostDocument {
  const file = target.file;
  if (!existsSync(file))
    return {
      root: {},
      raw: {},
      servers: {},
      text: "",
      indent: "  ",
      hadComments: false,
      existed: false,
      mode: 0o600,
      realFile: resolve(file),
    };
  const realFile = realpathSync(file);
  const text = readFileSync(realFile, "utf8");
  const parsed = text.trim() ? parseJsonc(text) : { value: {}, hadComments: false };
  if (!isPlainObject(parsed.value))
    throw new Error(`${file}: expected a JSON object at the top level`);
  const root = parsed.value;
  const raw = mapAt(root, target.path);
  const servers: Record<string, HostEntry> = {};
  if (raw) {
    for (const [k, v] of own(raw)) if (isPlainObject(v)) servers[k] = v;
  } else if (target.path.length === 1 && root[target.path[0] as string] !== undefined) {
    throw new Error(`${file}: "${target.path[0]}" is not an object`);
  }
  return {
    root,
    raw: raw ?? {},
    servers,
    text,
    indent: detectIndent(text),
    hadComments: parsed.hadComments,
    existed: true,
    mode: statSync(realFile).mode & 0o777,
    realFile,
  };
}

export const originKey = (doc: Pick<HostDocument, "realFile">, target: Target): string =>
  `${doc.realFile}#${target.path.join("/")}`;

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "T")
    .replace(/(\.\d{3})Z$/, "$1Z");

/** Copy the file to ~/.sayagain/backups before changing it. Never overwrites an earlier backup. */
export function backupFile(realFile: string): string {
  const dir = homePath("backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = realFile.replace(/^[\\/]+/, "").replace(/[\\/:]+/g, "_");
  const base = `${dir}/${stamp()}-${safe}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    try {
      copyFileSync(realFile, candidate, constants.COPYFILE_EXCL);
      chmodSync(candidate, 0o600);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/**
 * Apply `changes` (an entry, or null to delete) to the server map and write the file: backup first,
 * everything else in the file kept, indentation and mode kept, symlinks followed, atomic rename.
 */
export function writeHostFile(
  target: Target,
  doc: HostDocument,
  changes: Record<string, HostEntry | null>,
  opts: WriteOptions,
): string | undefined {
  const map: Record<string, unknown> = { ...doc.raw };
  for (const [name, entry] of Object.entries(changes)) {
    if (entry === null) delete map[name];
    else map[name] = entry;
  }
  const root = { ...doc.root };
  setAt(root, target.path, map);
  const text = `${JSON.stringify(root, null, doc.indent)}\n`;
  if (doc.hadComments)
    opts.log(
      `note: ${basename(target.file)} has comments; a rewrite does not keep them (the original stays in the backup)`,
    );
  if (opts.dryRun) {
    opts.log(`[dry-run] would write ${target.file}`);
    return undefined;
  }
  let backup: string | undefined;
  if (doc.existed) backup = backupFile(doc.realFile);
  else mkdirSync(dirname(doc.realFile), { recursive: true });
  const tmp = `${doc.realFile}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: doc.mode });
  renameSync(tmp, doc.realFile);
  try {
    chmodSync(doc.realFile, doc.mode);
  } catch {
    // best effort
  }
  return backup;
}

// ---------------------------------------------------------------- entries

/** The daemon's base URL as the registry configures it. */
export function daemonUrlFor(registry: Registry): string {
  const { host, port } = parseListen(registry.daemon?.listen ?? "127.0.0.1:7777");
  const h =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

const SAYAGAIN_BIN = /^sayagain(\.js|\.cmd|\.exe)?$/i;
/** The last path segment, whichever separator the host used. */
const leaf = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** The host entry that routes `name` through the boundary. */
export function boundaryEntry(
  spec: HostSpec,
  name: string,
  opts: EntryOptions & { dryRun?: boolean },
  registry: Registry,
): HostEntry {
  if (opts.transport === "http") {
    if (!spec.http)
      throw new Error(`${spec.label} does not accept HTTP entries; use --transport stdio`);
    const token = existsSync(tokenPath())
      ? readFileSync(tokenPath(), "utf8").trim()
      : opts.dryRun
        ? "<token>"
        : loadOrCreateToken();
    const entry: HostEntry = {
      url: `${daemonUrlFor(registry)}/mcp/${name}`,
      headers: { Authorization: `Bearer ${token}` },
    };
    return spec.typed ? { type: "http", ...entry } : entry;
  }
  let command: string;
  let args: string[];
  if (opts.command) {
    command = opts.command;
    args = ["stdio", name];
  } else {
    const launcher = opts.dryRun ? launcherPath() : ensureLauncher();
    if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", launcher, "stdio", name];
    } else {
      command = launcher;
      args = ["stdio", name];
    }
  }
  return spec.typed ? { type: "stdio", command, args } : { command, args };
}

/** Does this host entry already go through Say Again? */
export function isBoundaryEntry(entry: HostEntry, registry: Registry): boolean {
  const command = typeof entry.command === "string" ? leaf(entry.command) : "";
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const stdioAt = args.indexOf("stdio");
  if (
    stdioAt >= 0 &&
    (SAYAGAIN_BIN.test(command) || args.slice(0, stdioAt).some((a) => SAYAGAIN_BIN.test(leaf(a))))
  )
    return true;
  if (typeof entry.url === "string") {
    const prefix = `${daemonUrlFor(registry)}/mcp/`;
    if (
      entry.url.startsWith(prefix) &&
      NAME.test(entry.url.slice(prefix.length).replace(/\/$/, ""))
    )
      return true;
  }
  return false;
}

const HOST_VAR = /\$\{[^}]*\}/;
const PLAIN_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Translate values a host resolves itself into what the registry can resolve, or say why not. */
function translateValues(
  o: Record<string, unknown>,
): { values: Record<string, string> } | { reason: string } {
  const values: Record<string, string> = {};
  for (const [k, v] of own(o)) {
    let s = String(v);
    for (const m of s.matchAll(/\$\{([^}]*)\}/g)) {
      const inner = m[1] ?? "";
      if (inner.startsWith("input:"))
        return {
          reason: "uses VS Code input variables; register it by hand with --env or --header",
        };
      if (inner.startsWith("env:")) {
        const ref = `\${${inner.slice(4)}}`;
        if (!PLAIN_REF.test(ref))
          return { reason: `uses a variable the registry cannot resolve (${m[0]})` };
        s = s.replace(m[0], ref);
      } else if (!PLAIN_REF.test(m[0]))
        return { reason: `uses a variable the registry cannot resolve (${m[0]})` };
    }
    values[k] = s;
  }
  return { values };
}

/** Translate a host entry into a registry config, or explain why it cannot be. */
export function configFromEntry(
  entry: HostEntry,
  projectRoot?: string,
): { config: ServerConfig } | { reason: string } {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  for (const field of ["command", "args", "url", "cwd"]) {
    const v = entry[field];
    if (HOST_VAR.test(typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(" ") : ""))
      return { reason: `${field} uses a host variable the boundary cannot resolve` };
  }
  if (type === "sse")
    return { reason: "legacy SSE transport; the boundary speaks Streamable HTTP" };
  const isHttp =
    type === "http" ||
    type === "streamable-http" ||
    type === "streamablehttp" ||
    (type === undefined && typeof entry.url === "string");
  if (isHttp) {
    if (typeof entry.url !== "string") return { reason: "http entry without a url" };
    const config: ServerConfig = { transport: "http", url: entry.url };
    if (isPlainObject(entry.headers)) {
      const t = translateValues(entry.headers);
      if ("reason" in t) return t;
      if (Object.keys(t.values).length) config.headers = t.values;
    }
    return { config };
  }
  if (type === "stdio" || (type === undefined && typeof entry.command === "string")) {
    if (typeof entry.command !== "string") return { reason: "stdio entry without a command" };
    const config: ServerConfig = {
      transport: "stdio",
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    };
    if (isPlainObject(entry.env)) {
      const t = translateValues(entry.env);
      if ("reason" in t) return t;
      if (Object.keys(t.values).length) config.env = t.values;
    }
    if (typeof entry.cwd === "string")
      config.cwd = projectRoot ? resolve(projectRoot, entry.cwd) : resolve(entry.cwd);
    return { config };
  }
  return { reason: `unrecognised entry${type ? ` (type ${type})` : ""}` };
}

/** The part of a config that says what to run; tuning (classes, hold) and bookkeeping are left out. */
const transportPart = (c: ServerConfig): string =>
  JSON.stringify({
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: c.env,
    cwd: c.cwd,
    url: c.url,
    headers: c.headers,
  });
const sameTransport = (a: ServerConfig, b: ServerConfig): boolean =>
  transportPart(a) === transportPart(b);
const sameEntry = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- import / install / eject

export function importHost(target: Target, opts: ImportOptions): ImportResult {
  const spec = HOSTS[target.host];
  const doc = readHostFile(target);
  const registry = loadRegistry();
  const key = originKey(doc, target);
  const result: ImportResult = {
    file: target.file,
    imported: [],
    updated: [],
    unchanged: [],
    skipped: [],
    rewritten: [],
  };
  const changes: Record<string, HostEntry | null> = {};
  let registryChanged = false;
  for (const [name, entry] of own(doc.servers)) {
    if (isBoundaryEntry(entry, registry)) {
      result.skipped.push({ name, reason: "already goes through Say Again" });
      continue;
    }
    if (!NAME.test(name)) {
      result.skipped.push({ name, reason: "name has characters the registry does not accept" });
      continue;
    }
    const translated = configFromEntry(entry, projectRootOf(target));
    if ("reason" in translated) {
      result.skipped.push({ name, reason: translated.reason });
      continue;
    }
    const existing = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
    let config: ServerConfig;
    if (existing && !sameTransport(existing, translated.config)) {
      if (!opts.force) {
        result.skipped.push({
          name,
          reason: "already registered with a different command or url (use --force to replace)",
        });
        continue;
      }
      config = { ...existing, ...translated.config };
      result.updated.push(name);
    } else if (existing) {
      config = { ...existing };
      result.unchanged.push(name);
    } else {
      config = { ...translated.config, imported: true };
      result.imported.push(name);
    }
    const wrapped = opts.rewrite
      ? boundaryEntry(spec, name, { ...opts, dryRun: opts.dryRun }, registry)
      : undefined;
    const origin = { host: target.host, entry, ...(wrapped ? { wrapped } : {}) };
    const origins = { ...(config.origins ?? {}), [key]: origin };
    if (!existing || !sameEntry(existing, { ...config, origins })) {
      registry.servers[name] = { ...config, origins };
      registryChanged = true;
    }
    if (wrapped) {
      changes[name] = wrapped;
      result.rewritten.push(name);
    }
  }
  if (registryChanged && !opts.dryRun) saveRegistry(registry);
  if (result.rewritten.length) {
    const backup = writeHostFile(target, doc, changes, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/** Write boundary entries for registered servers into a host map: new keys, and keys that point elsewhere. */
export function installHost(
  target: Target,
  names: string[] | undefined,
  opts: WriteOptions & EntryOptions,
): InstallResult {
  const spec = HOSTS[target.host];
  const doc = readHostFile(target);
  const registry = loadRegistry();
  const key = originKey(doc, target);
  const wanted = names ?? Object.keys(registry.servers);
  const result: InstallResult = { file: target.file, added: [], rewritten: [], unchanged: [] };
  const changes: Record<string, HostEntry | null> = {};
  let registryChanged = false;
  for (const name of wanted) {
    const cfg = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
    if (!cfg) throw new Error(`no registered server named ${name}`);
    const current = Object.hasOwn(doc.servers, name) ? doc.servers[name] : undefined;
    const entry = boundaryEntry(spec, name, { ...opts, dryRun: opts.dryRun }, registry);
    if (current && sameEntry(current, entry)) {
      result.unchanged.push(name);
      continue;
    }
    if (current && !isBoundaryEntry(current, registry)) {
      cfg.origins = {
        ...(cfg.origins ?? {}),
        [key]: { host: target.host, entry: current, wrapped: entry },
      };
      registryChanged = true;
      result.rewritten.push(name);
    } else if (current) result.rewritten.push(name);
    else result.added.push(name);
    changes[name] = entry;
  }
  if (result.added.length || result.rewritten.length) {
    if (registryChanged && !opts.dryRun) saveRegistry(registry);
    const backup = writeHostFile(target, doc, changes, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/**
 * Put the host's original entries back. Servers `import` registered are unregistered once no origin
 * remains (unless kept). Boundary entries with no origin are removed when their server is registered
 * (they came from `install`); otherwise they are left alone unless `prune` is set.
 */
export function ejectHost(
  target: Target,
  names: string[] | undefined,
  opts: WriteOptions & { keep: boolean; prune: boolean },
): EjectResult {
  const doc = readHostFile(target);
  const registry = loadRegistry();
  const key = originKey(doc, target);
  const result: EjectResult = {
    file: target.file,
    restored: [],
    removed: [],
    unregistered: [],
    left: [],
  };
  const changes: Record<string, HostEntry | null> = {};
  let registryChanged = false;
  for (const [name, entry] of own(doc.servers)) {
    if (names && !names.includes(name)) continue;
    const cfg = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
    const origin = cfg?.origins?.[key];
    if (!isBoundaryEntry(entry, registry) && !(origin?.wrapped && sameEntry(entry, origin.wrapped)))
      continue;
    if (origin) {
      if (
        origin.wrapped &&
        !sameEntry(entry, origin.wrapped) &&
        !isBoundaryEntry(entry, registry)
      ) {
        result.left.push({ name, reason: "the entry was changed by hand since it was rewritten" });
        continue;
      }
      changes[name] = origin.entry as HostEntry;
      result.restored.push(name);
      const { [key]: _gone, ...rest } = cfg?.origins ?? {};
      if (cfg) {
        if (Object.keys(rest).length) cfg.origins = rest;
        else delete cfg.origins;
        registryChanged = true;
        if (!opts.keep && cfg.imported === true && !cfg.origins) {
          delete registry.servers[name];
          result.unregistered.push(name);
        }
      }
    } else if (cfg || opts.prune) {
      changes[name] = null;
      result.removed.push(name);
    } else {
      result.left.push({
        name,
        reason:
          "goes through Say Again but no server of that name is registered; --prune removes it",
      });
    }
  }
  if (registryChanged && !opts.dryRun) saveRegistry(registry);
  if (Object.keys(changes).length) {
    const backup = writeHostFile(target, doc, changes, opts);
    if (backup) result.backup = backup;
  }
  return result;
}

/** What a host map holds: which servers, which already go through Say Again. */
export function inspectHost(target: Target): { servers: string[]; wrapped: string[] } {
  const doc = readHostFile(target);
  const registry = loadRegistry();
  const servers = Object.keys(doc.servers);
  return {
    servers,
    wrapped: servers.filter((n) => isBoundaryEntry(doc.servers[n] as HostEntry, registry)),
  };
}
