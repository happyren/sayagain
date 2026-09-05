/** The registry of upstreams the daemon serves, and the daemon's own state file. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ToolClass } from "@sayagain/sdk";
import { ensureHome, homePath } from "./home.js";
import type { HoldMode } from "./policy.js";
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
  headers?: Record<string, string>;
  classes?: Record<string, ToolClass>;
  hold?: HoldMode;
  announce?: boolean;
}

export interface Registry {
  servers: Record<string, ServerConfig>;
  daemon?: { listen?: string; ledger?: "jsonl" | "sqlite" };
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

export function loadRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Registry>;
    return { servers: parsed.servers ?? {}, ...(parsed.daemon ? { daemon: parsed.daemon } : {}) };
  } catch (err) {
    throw new Error(`${p} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function saveRegistry(registry: Registry): void {
  ensureHome();
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export function addServer(name: string, config: ServerConfig): Registry {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
    throw new Error(`server name must match [A-Za-z0-9_.-]{1,64}, got ${JSON.stringify(name)}`);
  const registry = loadRegistry();
  registry.servers[name] = config;
  saveRegistry(registry);
  return registry;
}

export function removeServer(name: string): boolean {
  const registry = loadRegistry();
  if (!(name in registry.servers)) return false;
  delete registry.servers[name];
  saveRegistry(registry);
  return true;
}

/** Resolve "${VAR}" references against an environment; unknown references resolve to "". */
export function resolveEnv(
  env: Record<string, string> | undefined,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {}))
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => from[name] ?? "");
  return out;
}

export function upstreamFor(
  name: string,
  config: ServerConfig,
  log: (line: string) => void,
): Upstream {
  if (config.transport === "http") {
    if (!config.url) throw new Error(`server ${name}: http transport needs a url`);
    return new HttpUpstream({ url: config.url, headers: resolveEnv(config.headers), log });
  }
  if (!config.command) throw new Error(`server ${name}: stdio transport needs a command`);
  const env = { ...process.env, ...resolveEnv(config.env) };
  const opts: ConstructorParameters<typeof StdioUpstream>[0] = {
    command: config.command,
    args: config.args ?? [],
    env,
    log,
  };
  if (config.cwd !== undefined) opts.cwd = config.cwd;
  return new StdioUpstream(opts);
}

export function readDaemonInfo(): DaemonInfo | null {
  const p = daemonInfoPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureHome();
  mkdirSync(homePath(), { recursive: true });
  writeFileSync(daemonInfoPath(), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

export function removeDaemonInfo(): void {
  rmSync(daemonInfoPath(), { force: true });
}
