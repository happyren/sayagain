import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTS, hostFiles } from "./hosts.js";
import { parseJsonc, stripJsonc } from "./jsonc.js";
import {
  boundaryEntry,
  configFromEntry,
  ejectHost,
  importHost,
  inspectHost,
  installHost,
  isBoundaryEntry,
} from "./onboarding.js";
import { addServer, loadRegistry } from "./registry.js";

const quiet = { log: () => {} };

describe("jsonc", () => {
  it("strips comments and trailing commas outside strings", () => {
    const text = `{
  // user servers
  "servers": {
    "a": { "command": "x", "args": ["--url", "http://x/y", "// not a comment"], }, /* block */
  },
}`;
    const { value, hadComments } = parseJsonc(text);
    expect(hadComments).toBe(true);
    expect(value).toEqual({
      servers: { a: { command: "x", args: ["--url", "http://x/y", "// not a comment"] } },
    });
    expect(stripJsonc('{"a": "b"}').hadComments).toBe(false);
  });
});

describe("onboarding", () => {
  let dir = "";
  let previousHome: string | undefined;
  beforeEach(() => {
    dir = join(tmpdir(), `sayagain-onboard-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    previousHome = process.env.SAYAGAIN_HOME;
    process.env.SAYAGAIN_HOME = join(dir, "home");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.SAYAGAIN_HOME;
    else process.env.SAYAGAIN_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, content: string) => {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  };
  const read = (file: string) =>
    JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

  it("imports a Cursor file, rewrites entries in place with a backup, and keeps other keys", () => {
    const file = write(
      "mcp.json",
      `${JSON.stringify(
        {
          other: { keep: true },
          mcpServers: {
            notion: {
              command: "npx",
              args: ["-y", "@notionhq/notion-mcp-server"],
              env: { NOTION_TOKEN: "ntn_123" },
            },
            linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } },
            legacy: { type: "sse", url: "https://old.example/sse" },
            "bad name!": { command: "x" },
          },
        },
        null,
        4,
      )}\n`,
    );
    const target = { host: "cursor" as const, file, scope: "user" as const };
    const r = importHost(target, {
      ...quiet,
      rewrite: true,
      force: false,
      dryRun: false,
      transport: "stdio",
      command: "/opt/sayagain",
    });
    expect(r.imported).toEqual(["notion", "linear"]);
    expect(r.skipped).toEqual([
      { name: "legacy", reason: expect.stringContaining("SSE") },
      { name: "bad name!", reason: expect.stringContaining("name") },
    ]);
    expect(r.rewritten).toEqual(["notion", "linear"]);
    expect(r.backup).toMatch(/mcp\.json\.sayagain-backup-\d{8}T\d{6}Z$/);
    const after = read(file);
    expect(after.other).toEqual({ keep: true });
    expect(after.mcpServers?.notion).toEqual({
      command: "/opt/sayagain",
      args: ["stdio", "notion"],
    });
    expect(after.mcpServers?.legacy).toEqual({ type: "sse", url: "https://old.example/sse" });
    expect(readFileSync(file, "utf8").startsWith('{\n    "other"')).toBe(true); // 4-space indent kept
    const reg = loadRegistry();
    expect(reg.servers.notion).toMatchObject({
      transport: "stdio",
      command: "npx",
      env: { NOTION_TOKEN: "ntn_123" },
    });
    expect(reg.servers.linear).toMatchObject({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer abc" },
    });
    expect(reg.servers.notion?.origins?.[file]).toMatchObject({ host: "cursor" });
    expect(inspectHost(target)).toEqual({
      servers: ["notion", "linear", "legacy", "bad name!"],
      wrapped: ["notion", "linear"],
    });
    // Importing again changes nothing and writes nothing.
    const again = importHost(target, {
      ...quiet,
      rewrite: true,
      force: false,
      dryRun: false,
      transport: "stdio",
      command: "/opt/sayagain",
    });
    expect(again.imported).toEqual([]);
    expect(again.rewritten).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.includes("backup"))).toHaveLength(1);
  });

  it("ejects back to the original entries and unregisters what it imported, keeping hand-added servers", () => {
    const original = { command: "npx", args: ["-y", "srv"], env: { T: "1" } };
    const file = write("mcp.json", JSON.stringify({ mcpServers: { srv: original } }));
    const target = { host: "cursor" as const, file, scope: "user" as const };
    addServer("manual", { transport: "stdio", command: "x", imported: false });
    importHost(target, {
      ...quiet,
      rewrite: true,
      force: false,
      dryRun: false,
      transport: "stdio",
      command: "sayagain",
    });
    installHost(target, ["manual"], {
      ...quiet,
      dryRun: false,
      transport: "stdio",
      command: "sayagain",
    });
    expect(Object.keys(read(file).mcpServers ?? {})).toEqual(["srv", "manual"]);
    const e = ejectHost(target, undefined, { ...quiet, dryRun: false, keep: false });
    expect(e.restored).toEqual(["srv"]);
    expect(e.removed).toEqual(["manual"]);
    expect(e.unregistered).toEqual(["srv"]);
    expect(read(file).mcpServers).toEqual({ srv: original });
    expect(Object.keys(loadRegistry().servers)).toEqual(["manual"]);
  });

  it("dry-run touches nothing", () => {
    const file = write("mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const before = readFileSync(file, "utf8");
    const r = importHost(
      { host: "cursor", file, scope: "user" },
      { ...quiet, rewrite: true, force: false, dryRun: true, transport: "stdio" },
    );
    expect(r.imported).toEqual(["a"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(dir, "home", "config.json"))).toBe(false);
  });

  it("handles VS Code's servers key, typed entries, JSONC, and input variables", () => {
    const file = write(
      "mcp.json",
      `{
  // servers
  "servers": {
    "fs": { "type": "stdio", "command": "npx", "args": ["fs"] },
    "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${input:gh-token}" } },
  },
  "inputs": [{ "id": "gh-token", "type": "promptString" }]
}`,
    );
    const logs: string[] = [];
    const r = importHost(
      { host: "vscode", file, scope: "user" },
      {
        log: (l) => logs.push(l),
        rewrite: true,
        force: false,
        dryRun: false,
        transport: "stdio",
        command: "sayagain",
      },
    );
    expect(r.imported).toEqual(["fs"]);
    expect(r.skipped).toEqual([{ name: "gh", reason: expect.stringContaining("input variables") }]);
    const after = read(file);
    expect(after.servers?.fs).toEqual({
      type: "stdio",
      command: "sayagain",
      args: ["stdio", "fs"],
    });
    expect(after.inputs).toEqual([{ id: "gh-token", type: "promptString" }]);
    expect(logs.some((l) => l.includes("comments"))).toBe(true);
  });

  it("writes http entries for hosts that accept them and refuses for Claude Desktop", () => {
    addServer("n", { transport: "stdio", command: "x" });
    const entry = boundaryEntry(HOSTS["claude-code"], "n", { transport: "http" }, loadRegistry());
    expect(entry).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:7777/mcp/n",
      headers: { Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{16,}$/) },
    });
    expect(isBoundaryEntry(entry)).toBe(true);
    expect(() =>
      boundaryEntry(HOSTS["claude-desktop"], "n", { transport: "http" }, loadRegistry()),
    ).toThrow(/Claude Desktop/);
    const gui = boundaryEntry(HOSTS["claude-desktop"], "n", { transport: "stdio" }, loadRegistry());
    expect(gui.command).toBe(process.execPath);
    expect((gui.args as string[])[0]).toMatch(/cli\.js$/);
    expect(isBoundaryEntry(gui)).toBe(true);
    expect(isBoundaryEntry({ command: "npx", args: ["-y", "stdio-thing"] })).toBe(false);
  });

  it("translates entries and detects host files under a custom home", () => {
    expect(configFromEntry({ command: "uvx", args: ["srv"], cwd: "/w" })).toEqual({
      config: { transport: "stdio", command: "uvx", args: ["srv"], cwd: "/w" },
    });
    expect(configFromEntry({ type: "http", url: "https://x/mcp" })).toEqual({
      config: { transport: "http", url: "https://x/mcp" },
    });
    expect(configFromEntry({ nonsense: 1 })).toEqual({
      reason: expect.stringContaining("unrecognised"),
    });
    const files = hostFiles("/proj");
    expect(files.map((f) => f.host)).toEqual([
      "claude-code",
      "claude-code",
      "cursor",
      "cursor",
      "claude-desktop",
      "vscode",
      "vscode",
    ]);
    expect(files.find((f) => f.host === "claude-code" && f.scope === "project")?.file).toBe(
      "/proj/.mcp.json",
    );
    expect(files.find((f) => f.host === "vscode" && f.scope === "project")?.file).toBe(
      "/proj/.vscode/mcp.json",
    );
  });
});
