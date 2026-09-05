/**
 * The MCP hosts Say Again can onboard: where each keeps its server map, what
 * an entry looks like, and whether the host inherits a shell PATH.
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type HostId = "claude-code" | "cursor" | "claude-desktop" | "vscode";
export type Scope = "user" | "project";

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
  file(scope: Scope, cwd: string): string;
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
    scopes: ["user", "project"],
    file: (scope, cwd) =>
      scope === "user" ? join(homedir(), ".claude.json") : join(cwd, ".mcp.json"),
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
export const isHostId = (s: string): s is HostId => s in HOSTS;

export interface HostFile {
  host: HostId;
  scope: Scope;
  file: string;
  exists: boolean;
}

/** Every host config location on this machine, existing or not. */
export function hostFiles(
  cwd: string = process.cwd(),
  scopes: Scope[] = ["user", "project"],
): HostFile[] {
  const out: HostFile[] = [];
  for (const spec of Object.values(HOSTS))
    for (const scope of spec.scopes) {
      if (!scopes.includes(scope)) continue;
      const file = spec.file(scope, cwd);
      out.push({ host: spec.id, scope, file, exists: existsSync(file) });
    }
  return out;
}
