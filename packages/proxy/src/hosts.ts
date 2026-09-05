/**
 * The MCP hosts Say Again can onboard: where each keeps its server map, what
 * an entry looks like, and whether the host inherits a shell PATH.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";

export type HostId = "claude-code" | "cursor" | "claude-desktop" | "vscode";
/** user: the host's global file; project: a file inside the project; local: Claude Code's per-project map inside the user file. */
export type Scope = "user" | "project" | "local";

export interface HostSpec {
  id: HostId;
  label: string;
  /** The property holding the server map. */
  key: "mcpServers" | "servers";
  /** Whether stdio entries carry `"type": "stdio"`. */
  typed: boolean;
  /** Whether the host accepts `{ "type": "http", "url", "headers" }` entries. */
  http: boolean;
  /** GUI hosts do not inherit the shell PATH; entries need absolute paths. */
  gui: boolean;
  scopes: Scope[];
  file(scope: "user" | "project", cwd: string): string;
}

const appData = (): string => process.env.APPDATA || join(homedir(), "AppData", "Roaming");
const userDir = (mac: string, linux: string, win: string): string => {
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Application Support", mac);
  if (os === "win32") return join(appData(), win);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), linux);
};

export const HOSTS: Record<HostId, HostSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    key: "mcpServers",
    typed: true,
    http: true,
    gui: false,
    scopes: ["user", "local", "project"],
    file: (scope, cwd) =>
      scope === "user"
        ? join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json")
        : join(cwd, ".mcp.json"),
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    key: "mcpServers",
    typed: false,
    http: true,
    gui: true,
    scopes: ["user", "project"],
    file: (scope, cwd) =>
      scope === "user" ? join(homedir(), ".cursor", "mcp.json") : join(cwd, ".cursor", "mcp.json"),
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    key: "mcpServers",
    typed: false,
    http: false,
    gui: true,
    scopes: ["user"],
    file: () => join(userDir("Claude", "Claude", "Claude"), "claude_desktop_config.json"),
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    key: "servers",
    typed: true,
    http: true,
    gui: true,
    scopes: ["user", "project"],
    file: (scope, cwd) =>
      scope === "user"
        ? join(userDir("Code", "Code", "Code"), "User", "mcp.json")
        : join(cwd, ".vscode", "mcp.json"),
  },
};

export const HOST_IDS = Object.keys(HOSTS) as HostId[];
export const isHostId = (s: string): s is HostId => Object.hasOwn(HOSTS, s);

/** One server map to onboard: a file, and the path of the map inside it. */
export interface Target {
  host: HostId;
  scope: Scope;
  file: string;
  /** Property path to the server map, e.g. ["mcpServers"] or ["projects", "/w/app", "mcpServers"]. */
  path: string[];
  /** For local scope: the project directory the map belongs to. */
  project?: string;
}

export interface HostFile extends Target {
  exists: boolean;
}

/** The project directory a target's relative paths resolve against. */
export function projectRootOf(t: Target): string | undefined {
  if (t.scope === "local") return t.project;
  if (t.scope !== "project") return undefined;
  const dir = resolve(t.file, "..");
  return /[\\/]\.(cursor|vscode)$/.test(dir) ? resolve(dir, "..") : dir;
}

/** Claude Code keeps per-project ("local") maps inside the user file: projects[<dir>].mcpServers. */
function claudeCodeLocalTargets(file: string): Target[] {
  if (!existsSync(file)) return [];
  try {
    const root = parseJsonc(readFileSync(file, "utf8")).value as {
      projects?: Record<string, { mcpServers?: unknown }>;
    };
    const projects = root?.projects;
    if (typeof projects !== "object" || projects === null) return [];
    return Object.entries(projects)
      .filter(
        ([, p]) =>
          typeof p?.mcpServers === "object" &&
          p.mcpServers !== null &&
          Object.keys(p.mcpServers as object).length > 0,
      )
      .map(([dir]) => ({
        host: "claude-code" as const,
        scope: "local" as const,
        file,
        path: ["projects", dir, "mcpServers"],
        project: dir,
      }));
  } catch {
    return [];
  }
}

/** Every host server map on this machine, existing or not (local-scope maps only when they exist). */
export function hostFiles(
  cwd: string = process.cwd(),
  scopes: Scope[] = ["user", "local", "project"],
): HostFile[] {
  const out: HostFile[] = [];
  for (const spec of Object.values(HOSTS))
    for (const scope of spec.scopes) {
      if (!scopes.includes(scope)) continue;
      if (scope === "local") {
        for (const t of claudeCodeLocalTargets(spec.file("user", cwd)))
          out.push({ ...t, exists: true });
        continue;
      }
      const file = spec.file(scope, cwd);
      out.push({ host: spec.id, scope, file, path: [spec.key], exists: existsSync(file) });
    }
  return out;
}
