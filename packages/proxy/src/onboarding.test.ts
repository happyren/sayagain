/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: host variables like "${env:HOME}" are the subject under test */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTS, hostFiles, type Target } from "./hosts.js";
import { parseJsonc, stripJsonc } from "./jsonc.js";
import { launcherPath } from "./launcher.js";
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
const stdio = { transport: "stdio" as const };

describe("jsonc", () => {
  it("strips comments and trailing commas outside strings, and a BOM", () => {
    const text = `\uFEFF{
  // user servers
  "servers": {
    "a": { "command": "x", "args": ["--url", "http://x/y", "// not a comment", "a,]", "x, }"], }, /* block */
  },
}`;
    const { value, hadComments } = parseJsonc(text);
    expect(hadComments).toBe(true);
    expect(value).toEqual({
      servers: {
        a: { command: "x", args: ["--url", "http://x/y", "// not a comment", "a,]", "x, }"] },
      },
    });
    expect(stripJsonc('{"a": "b"}').hadComments).toBe(false);
    expect(parseJsonc('{"s":"a\\"b,]", "t": [1,2, // c\n]}').value).toEqual({
      s: 'a"b,]',
      t: [1, 2],
    });
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
  const write = (name: string, content: string, mode = 0o644) => {
    const file = join(dir, name);
    writeFileSync(file, content, { mode });
    return file;
  };
  const read = (file: string) =>
    JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
  const cursor = (file: string): Target => ({
    host: "cursor",
    scope: "user",
    file,
    path: ["mcpServers"],
  });
  const backups = () =>
    existsSync(join(dir, "home", "backups")) ? readdirSync(join(dir, "home", "backups")) : [];

  it("imports a Cursor file, rewrites entries in place with a backup, and keeps other keys, indentation and mode", () => {
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
            disabled: null,
          },
        },
        null,
        4,
      )}\n`,
      0o600,
    );
    const target = cursor(file);
    const r = importHost(target, {
      ...quiet,
      ...stdio,
      rewrite: true,
      force: false,
      dryRun: false,
    });
    expect(r.imported).toEqual(["notion", "linear"]);
    expect(r.skipped).toEqual([
      { name: "legacy", reason: expect.stringContaining("SSE") },
      { name: "bad name!", reason: expect.stringContaining("name") },
    ]);
    expect(r.rewritten).toEqual(["notion", "linear"]);
    expect(r.backup).toMatch(/home\/backups\/\d{8}T\d{6}\.\d{3}Z-.*mcp\.json$/);
    expect(statSync(r.backup ?? "").mode & 0o777).toBe(0o600);
    const after = read(file);
    expect(after.other).toEqual({ keep: true });
    expect(after.mcpServers?.notion).toEqual({
      command: launcherPath(),
      args: ["stdio", "notion"],
    });
    expect(after.mcpServers?.legacy).toEqual({ type: "sse", url: "https://old.example/sse" });
    expect(after.mcpServers?.disabled).toBeNull(); // non-object entries survive a rewrite
    expect(readFileSync(file, "utf8").startsWith('{\n    "other"')).toBe(true); // 4-space indent kept
    expect(statSync(file).mode & 0o777).toBe(0o600); // mode kept
    expect(existsSync(launcherPath())).toBe(true);
    expect(statSync(launcherPath()).mode & 0o777).toBe(0o700);
    const reg = loadRegistry();
    expect(reg.servers.notion).toMatchObject({
      transport: "stdio",
      command: "npx",
      env: { NOTION_TOKEN: "ntn_123" },
      imported: true,
    });
    expect(reg.servers.linear).toMatchObject({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer abc" },
    });
    const originKey = Object.keys(reg.servers.notion?.origins ?? {})[0] ?? "";
    expect(originKey).toMatch(/mcp\.json#mcpServers$/);
    expect(reg.servers.notion?.origins?.[originKey]).toMatchObject({
      host: "cursor",
      wrapped: after.mcpServers?.notion,
    });
    expect(inspectHost(target)).toEqual({
      servers: ["notion", "linear", "legacy", "bad name!"],
      wrapped: ["notion", "linear"],
    });
    // Importing again changes nothing and writes nothing.
    const again = importHost(target, {
      ...quiet,
      ...stdio,
      rewrite: true,
      force: false,
      dryRun: false,
    });
    expect(again.imported).toEqual([]);
    expect(again.unchanged).toEqual([]);
    expect(again.rewritten).toEqual([]);
    expect(backups()).toHaveLength(1);
  });

  it("ejects back to the original entries and unregisters what it imported, keeping hand-added servers", () => {
    const original = { command: "npx", args: ["-y", "srv"], env: { T: "1" } };
    const file = write(
      "mcp.json",
      JSON.stringify({ mcpServers: { srv: original, manual: { command: "old" } } }),
    );
    const target = cursor(file);
    addServer("manual", {
      transport: "stdio",
      command: "x",
      classes: { delete_page: "destructive" },
    });
    importHost(target, { ...quiet, ...stdio, rewrite: true, force: false, dryRun: false });
    const inst = installHost(target, ["manual"], { ...quiet, ...stdio, dryRun: false });
    expect(inst.rewritten).toEqual(["manual"]);
    expect(inspectHost(target).wrapped).toEqual(["srv", "manual"]);
    const e = ejectHost(target, undefined, { ...quiet, dryRun: false, keep: false, prune: false });
    expect(e.restored).toEqual(["srv", "manual"]);
    expect(e.unregistered).toEqual(["srv"]);
    expect(read(file).mcpServers).toEqual({ srv: original, manual: { command: "old" } });
    expect(loadRegistry().servers).toEqual({
      manual: { transport: "stdio", command: "x", classes: { delete_page: "destructive" } },
    });
  });

  it("eject with names, --keep, an orphaned entry, --prune, and a hand-edited entry", () => {
    const file = write(
      "mcp.json",
      JSON.stringify({
        mcpServers: {
          a: { command: "a" },
          b: { command: "b" },
          stray: { command: "sayagain", args: ["stdio", "gone"] },
        },
      }),
    );
    const target = cursor(file);
    importHost(target, { ...quiet, ...stdio, rewrite: true, force: false, dryRun: false });
    const first = ejectHost(target, ["a"], { ...quiet, dryRun: false, keep: true, prune: false });
    expect(first.restored).toEqual(["a"]);
    expect(first.unregistered).toEqual([]);
    expect(Object.keys(loadRegistry().servers)).toEqual(["a", "b"]);
    // b's entry edited by hand after the rewrite: left alone.
    const edited = read(file);
    edited.mcpServers = { ...edited.mcpServers, b: { command: "node", args: ["custom.js"] } };
    writeFileSync(file, JSON.stringify(edited));
    const second = ejectHost(target, undefined, {
      ...quiet,
      dryRun: false,
      keep: false,
      prune: false,
    });
    expect(second.left).toEqual([{ name: "stray", reason: expect.stringContaining("--prune") }]);
    expect(second.restored).toEqual([]);
    const third = ejectHost(target, undefined, {
      ...quiet,
      dryRun: false,
      keep: false,
      prune: true,
    });
    expect(third.removed).toEqual(["stray"]);
    expect(Object.keys(read(file).mcpServers ?? {})).toEqual(["a", "b"]);
  });

  it("dry-run touches nothing, not even the token or launcher", () => {
    const file = write("mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const before = readFileSync(file, "utf8");
    const r = importHost(
      { host: "claude-code", scope: "user", file, path: ["mcpServers"] },
      { ...quiet, transport: "http", rewrite: true, force: false, dryRun: true },
    );
    expect(r.imported).toEqual(["a"]);
    expect(r.rewritten).toEqual(["a"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(dir, "home"))).toBe(false);
    importHost(cursor(file), { ...quiet, ...stdio, rewrite: true, force: false, dryRun: true });
    expect(existsSync(join(dir, "home"))).toBe(false);
  });

  it("handles VS Code's servers key, typed entries, JSONC, input and env variables", () => {
    const file = write(
      "mcp.json",
      `{
  // servers
  "servers": {
    "fs": { "type": "stdio", "command": "npx", "args": ["fs"], "env": { "HOME_DIR": "\${env:HOME}", "MODE": "x" } },
    "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${input:gh-token}" } },
    "ws": { "type": "stdio", "command": "\${workspaceFolder}/bin/srv" },
    "dflt": { "command": "srv", "env": { "T": "\${TOKEN:-none}" } },
  },
  "inputs": [{ "id": "gh-token", "type": "promptString" }]
}`,
    );
    const logs: string[] = [];
    const target: Target = { host: "vscode", scope: "user", file, path: ["servers"] };
    const r = importHost(target, {
      log: (l) => logs.push(l),
      ...stdio,
      rewrite: true,
      force: false,
      dryRun: false,
    });
    expect(r.imported).toEqual(["fs"]);
    expect(r.skipped.map((s) => s.name)).toEqual(["gh", "ws", "dflt"]);
    expect(r.skipped[0]?.reason).toContain("input variables");
    expect(loadRegistry().servers.fs?.env).toEqual({ HOME_DIR: "${HOME}", MODE: "x" });
    const after = read(file);
    expect(after.servers?.fs).toEqual({
      type: "stdio",
      command: launcherPath(),
      args: ["stdio", "fs"],
    });
    expect(after.inputs).toEqual([{ id: "gh-token", type: "promptString" }]);
    expect(logs.some((l) => l.includes("comments"))).toBe(true);
  });

  it("reads and writes Claude Code's user file with its local-scope project maps", () => {
    const file = write(
      ".claude.json",
      JSON.stringify({
        numStartups: 12,
        oauthAccount: { emailAddress: "x@y" },
        mcpServers: { global: { type: "stdio", command: "g" } },
        projects: {
          "/w/app": {
            allowedTools: [],
            mcpServers: { local1: { command: "l1", args: [] } },
            history: [1, 2],
          },
          "/w/empty": { mcpServers: {} },
          "/w/none": { allowedTools: ["Bash"] },
        },
      }),
      0o600,
    );
    const targets = hostFiles("/w/app", ["user", "project"]).filter(
      (t) => t.host === "claude-code",
    );
    expect(targets.map((t) => [t.scope, t.path.join("/")])).toEqual([
      ["user", "mcpServers"],
      ["project", "mcpServers"],
    ]);
    // hostFiles reads the real ~/.claude.json for local scopes; here we build the local target by hand.
    const local: Target = {
      host: "claude-code",
      scope: "local",
      file,
      path: ["projects", "/w/app", "mcpServers"],
      project: "/w/app",
    };
    const user: Target = { host: "claude-code", scope: "user", file, path: ["mcpServers"] };
    const r1 = importHost(user, { ...quiet, ...stdio, rewrite: true, force: false, dryRun: false });
    const r2 = importHost(local, {
      ...quiet,
      ...stdio,
      rewrite: true,
      force: false,
      dryRun: false,
    });
    expect(r1.rewritten).toEqual(["global"]);
    expect(r2.rewritten).toEqual(["local1"]);
    const after = read(file) as unknown as {
      numStartups: number;
      oauthAccount: unknown;
      mcpServers: Record<string, unknown>;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(after.numStartups).toBe(12);
    expect(after.oauthAccount).toEqual({ emailAddress: "x@y" });
    expect(after.mcpServers.global).toEqual({
      type: "stdio",
      command: launcherPath(),
      args: ["stdio", "global"],
    });
    expect(after.projects["/w/app"]?.mcpServers).toEqual({
      local1: { type: "stdio", command: launcherPath(), args: ["stdio", "local1"] },
    });
    expect(after.projects["/w/app"]?.history).toEqual([1, 2]);
    expect(after.projects["/w/none"]).toEqual({ allowedTools: ["Bash"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(loadRegistry().servers.local1?.origins ?? {})[0]).toMatch(
      /#projects\/\/w\/app\/mcpServers$/,
    );
    ejectHost(local, undefined, { ...quiet, dryRun: false, keep: false, prune: false });
    ejectHost(user, undefined, { ...quiet, dryRun: false, keep: false, prune: false });
    const restored = read(file) as unknown as typeof after;
    expect(restored.mcpServers).toEqual({ global: { type: "stdio", command: "g" } });
    expect(restored.projects["/w/app"]?.mcpServers).toEqual({
      local1: { command: "l1", args: [] },
    });
    expect(loadRegistry().servers).toEqual({});
  });

  it("follows a symlinked config and keys origins by the real path", () => {
    const real = write("real.json", JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    const r = importHost(cursor(link), {
      ...quiet,
      ...stdio,
      rewrite: true,
      force: false,
      dryRun: false,
    });
    expect(r.rewritten).toEqual(["a"]);
    expect(statSync(link, { throwIfNoEntry: true }).isFile()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(launcherPath());
    expect(require("node:fs").lstatSync(link).isSymbolicLink()).toBe(true);
    const e = ejectHost(cursor(real), undefined, {
      ...quiet,
      dryRun: false,
      keep: false,
      prune: false,
    });
    expect(e.restored).toEqual(["a"]);
  });

  it("--force replaces the transport part only; a differing server without it is skipped", () => {
    addServer("n", { transport: "stdio", command: "old", hold: "always" });
    const file = write(
      "mcp.json",
      JSON.stringify({ mcpServers: { n: { command: "new", args: ["1"] } } }),
    );
    const r = importHost(cursor(file), {
      ...quiet,
      ...stdio,
      rewrite: false,
      force: false,
      dryRun: false,
    });
    expect(r.skipped).toEqual([{ name: "n", reason: expect.stringContaining("--force") }]);
    const f = importHost(cursor(file), {
      ...quiet,
      ...stdio,
      rewrite: false,
      force: true,
      dryRun: false,
    });
    expect(f.updated).toEqual(["n"]);
    expect(loadRegistry().servers.n).toMatchObject({ command: "new", args: ["1"], hold: "always" });
    expect(loadRegistry().servers.n?.imported).toBeUndefined();
  });

  it("writes http entries for hosts that accept them (no type for Cursor), refuses Claude Desktop, and detects its own entries", () => {
    addServer("n", { transport: "stdio", command: "x" });
    const registry = loadRegistry();
    const cc = boundaryEntry(HOSTS["claude-code"], "n", { transport: "http" }, registry);
    expect(cc).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:7777/mcp/n",
      headers: { Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{16,}$/) },
    });
    expect(boundaryEntry(HOSTS.cursor, "n", { transport: "http" }, registry)).not.toHaveProperty(
      "type",
    );
    expect(isBoundaryEntry(cc, registry)).toBe(true);
    expect(() =>
      boundaryEntry(HOSTS["claude-desktop"], "n", { transport: "http" }, registry),
    ).toThrow(/Claude Desktop/);
    expect(
      boundaryEntry(
        HOSTS["claude-desktop"],
        "n",
        { transport: "stdio", command: "/opt/sayagain" },
        registry,
      ),
    ).toEqual({ command: "/opt/sayagain", args: ["stdio", "n"] });
    expect(
      isBoundaryEntry({ command: "npx", args: ["-y", "sayagain", "stdio", "n"] }, registry),
    ).toBe(true);
    expect(
      isBoundaryEntry({ command: "C:\\bin\\sayagain.cmd", args: ["stdio", "n"] }, registry),
    ).toBe(true);
    expect(
      isBoundaryEntry({ command: "node", args: ["/x/other-mcp/dist/cli.js", "stdio"] }, registry),
    ).toBe(false);
    expect(isBoundaryEntry({ url: "http://localhost:3000/mcp/foo" }, registry)).toBe(false);
    expect(isBoundaryEntry({ url: "http://127.0.0.1:7777/mcp/foo" }, registry)).toBe(true);
    expect(isBoundaryEntry({ command: "npx", args: ["-y", "stdio-thing"] }, registry)).toBe(false);
  });

  it("translates entries, resolves cwd against the project, and lists host files", () => {
    expect(configFromEntry({ command: "uvx", args: ["srv"], cwd: "./s" }, "/w/app")).toEqual({
      config: { transport: "stdio", command: "uvx", args: ["srv"], cwd: "/w/app/s" },
    });
    expect(configFromEntry({ type: "streamable-http", url: "https://x/mcp" })).toEqual({
      config: { transport: "http", url: "https://x/mcp" },
    });
    expect(configFromEntry({ nonsense: 1 })).toEqual({
      reason: expect.stringContaining("unrecognised"),
    });
    expect(configFromEntry({ command: "x", args: ["${HOME}/y"] })).toEqual({
      reason: expect.stringContaining("args"),
    });
    const files = hostFiles("/proj", ["user", "project"]);
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
    expect(files.find((f) => f.host === "vscode" && f.scope === "project")).toMatchObject({
      file: "/proj/.vscode/mcp.json",
      path: ["servers"],
    });
  });

  it("refuses to install an unregistered server and preserves a 0644 file's mode", () => {
    const file = write("mcp.json", JSON.stringify({ mcpServers: {} }), 0o644);
    chmodSync(file, 0o644);
    expect(() =>
      installHost(cursor(file), ["nope"], { ...quiet, ...stdio, dryRun: false }),
    ).toThrow(/no registered server named nope/);
    addServer("ok", { transport: "stdio", command: "x" });
    const r = installHost(cursor(file), undefined, { ...quiet, ...stdio, dryRun: false });
    expect(r.added).toEqual(["ok"]);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(read(file).mcpServers?.ok).toEqual({ command: launcherPath(), args: ["stdio", "ok"] });
  });
});
