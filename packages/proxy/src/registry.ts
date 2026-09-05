/** The registry of upstreams the daemon serves, the daemon's token, and its state file. */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolClass } from "@sayagain/sdk";
import { ensureHome, homePath } from "./home.js";
import type { HoldMode } from "./policy.js";
import type { StoreKind } from "./stores.js";
import type { Upstream } from "./transport.js";
import { HttpUpstream } from "./upstream-http.js";
import { StdioUpstream } from "./upstream-stdio.js";

export interface ServerConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** Values may be "${VAR}" references resolved from the daemon's environment at spawn. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Values may be "${VAR}" references, resolved per request from the daemon's environment. */
  headers?: Record<string, string>;
  classes?: Record<string, ToolClass>;
  hold?: HoldMode;
  announce?: boolean;
  /**
   * Where `import` found this server, keyed by "<file>#<path>": the entry it replaced and the entry
   * written in its place, so `eject` can restore the original.
   */
  origins?: Record<string, { host: string; entry: unknown; wrapped?: unknown }>;
  /** True for servers `import` registered: `eject` unregisters them once no origin remains. */
  imported?: boolean;
}

export interface Registry {
  servers: Record<string, ServerConfig>;
  daemon?: { listen?: string; store?: Exclude<StoreKind, "memory">; db?: string; otlp?: string };
  /** `sayagain contribute` settings (ADR-0009): contributor id, consent, endpoint, weekly. */
  contribute?: {
    contributor?: string;
    consent?: { termsVersion: string; acceptedAt: string };
    endpoint?: string;
    weekly?: boolean;
    lastSentAt?: string;
    /** Ids whose deletion the index has not confirmed yet; retried by the next --forget. */
    pendingForget?: string[];
  };
}

export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

export const registryPath = (): string => homePath("config.json");
export const daemonInfoPath = (): string => homePath("daemon.json");
export const tokenPath = (): string => homePath("token");

export function loadRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Registry>;
    return {
      servers: parsed.servers ?? {},
      ...(parsed.daemon ? { daemon: parsed.daemon } : {}),
      ...(parsed.contribute ? { contribute: parsed.contribute } : {}),
    };
  } catch (err) {
    throw new Error(`${p} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write a private file atomically: tmp file, 0600, rename over the target. */
function writePrivate(path: string, text: string): void {
  ensureHome();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // not fatal: the home directory is 0700
  }
}

export function saveRegistry(registry: Registry): void {
  writePrivate(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export const isValidServerName = (name: string): boolean =>
  /^[A-Za-z0-9_.-]{1,64}$/.test(name) && !["__proto__", "constructor", "prototype"].includes(name);

/** Register or replace a server; returns whether a server of that name already existed. */
export function addServer(name: string, config: ServerConfig): boolean {
  if (!isValidServerName(name))
    throw new Error(`server name must match [A-Za-z0-9_.-]{1,64}, got ${JSON.stringify(name)}`);
  const registry = loadRegistry();
  const existed = name in registry.servers;
  registry.servers[name] = config;
  saveRegistry(registry);
  return existed;
}

export function removeServer(name: string): boolean {
  const registry = loadRegistry();
  if (!(name in registry.servers)) return false;
  delete registry.servers[name];
  saveRegistry(registry);
  return true;
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve "${VAR}" references against an environment; unknown references resolve to "". */
export function resolveEnv(
  env: Record<string, string> | undefined,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {}))
    out[k] = v.replace(REF, (_, name: string) => from[name] ?? "");
  return out;
}

/** The "${VAR}" references in `env` that the environment does not define. */
export function unresolvedRefs(
  env: Record<string, string> | undefined,
  from: NodeJS.ProcessEnv = process.env,
): string[] {
  const missing = new Set<string>();
  for (const v of Object.values(env ?? {}))
    for (const m of v.matchAll(REF)) if (from[m[1] ?? ""] === undefined) missing.add(m[1] ?? "");
  return [...missing];
}

export function upstreamFor(
  name: string,
  config: ServerConfig,
  log: (line: string) => void,
): Upstream {
  const warn = (what: string, refs: string[]) => {
    if (refs.length)
      log(
        `sayagain: server ${name}: ${what} reference ${refs.map((r) => `\${${r}}`).join(", ")} but the daemon's environment does not define ${refs.length === 1 ? "it" : "them"}; resolved to empty`,
      );
  };
  if (config.transport === "http") {
    if (!config.url) throw new Error(`server ${name}: http transport needs a url`);
    warn("headers", unresolvedRefs(config.headers));
    return new HttpUpstream({ url: config.url, headers: resolveEnv(config.headers), log });
  }
  if (!config.command) throw new Error(`server ${name}: stdio transport needs a command`);
  warn("env", unresolvedRefs(config.env));
  const env = { ...process.env, ...resolveEnv(config.env) };
  const opts: ConstructorParameters<typeof StdioUpstream>[0] = {
    command: config.command,
    args: config.args ?? [],
    env,
    log,
  };
  if (config.cwd !== undefined) opts.cwd = resolve(config.cwd);
  return new StdioUpstream(opts);
}

/** The daemon's bearer token: created once, kept in a 0600 file, stable across restarts. */
export function loadOrCreateToken(): string {
  const p = tokenPath();
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(t)) return t;
  }
  const token = randomBytes(24).toString("base64url");
  writePrivate(p, `${token}\n`);
  return token;
}

/** The daemon's base URL, with an IPv6 host bracketed. */
export const daemonBaseUrl = (info: Pick<DaemonInfo, "host" | "port">): string =>
  `http://${info.host.includes(":") ? `[${info.host}]` : info.host}:${info.port}`;

export function readDaemonInfo(): DaemonInfo | null {
  const p = daemonInfoPath();
  if (!existsSync(p)) return null;
  try {
    const info = JSON.parse(readFileSync(p, "utf8")) as Partial<DaemonInfo>;
    if (
      typeof info.pid !== "number" ||
      typeof info.port !== "number" ||
      typeof info.token !== "string"
    )
      return null;
    return info as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  writePrivate(daemonInfoPath(), `${JSON.stringify(info, null, 2)}\n`);
}

/** Remove the state file, but only if it still describes this process (another daemon may have replaced it). */
export function removeDaemonInfo(pid: number = process.pid): void {
  const current = readDaemonInfo();
  if (current && current.pid !== pid) return;
  rmSync(daemonInfoPath(), { force: true });
}
