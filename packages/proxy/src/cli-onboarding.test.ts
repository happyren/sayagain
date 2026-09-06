import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { startDaemon } from "./daemon.js";
import { openStores } from "./stores.js";

/** Drive the real command line with HOME and SAYAGAIN_HOME pointed at a scratch directory. */
describe("cli onboarding", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  let out = "";
  let err = "";
  beforeEach(() => {
    dir = join(tmpdir(), `sayagain-cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "home"), { recursive: true });
    for (const k of ["HOME", "SAYAGAIN_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"])
      saved[k] = process.env[k];
    process.env.HOME = dir;
    process.env.SAYAGAIN_HOME = join(dir, "sayagain");
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err += String(c);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("hosts, import --host all --dry-run, then import --rewrite --no-start and eject --host all", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { g: { command: "g" } },
        projects: { "/w": { mcpServers: { l: { command: "l" } } } },
      }),
    );
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { c: { url: "https://c/mcp" } } }),
    );
    expect(await main(["hosts"])).toBe(0);
    expect(out).toMatch(/Claude Code\s+user\s+1 server\(s\), 0 through Say Again/);
    expect(out).toMatch(/Claude Code\s+local \/w\s+1 server\(s\)/);
    expect(out).toMatch(/Cursor\s+user\s+1 server\(s\)/);
    out = "";
    expect(await main(["import", "--host", "all", "--dry-run", "--rewrite"])).toBe(0);
    expect(out).toContain("[dry-run] Claude Code (user)");
    expect(out).toContain("[dry-run] Claude Code (local: /w)");
    expect(out).toContain("imported 1 (c)");
    expect(readFileSync(join(dir, ".claude.json"), "utf8")).not.toContain("sayagain");
    out = "";
    expect(await main(["import", "--host", "all", "--rewrite", "--no-start"])).toBe(0);
    expect(out).toContain("restart the host to pick up the change");
    const cc = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
      projects: Record<string, { mcpServers: Record<string, { args: string[] }> }>;
    };
    expect(cc.mcpServers.g?.args).toEqual(["stdio", "g"]);
    expect(cc.mcpServers.g?.command).toBe(join(dir, "sayagain", "bin", "sayagain"));
    expect(cc.projects["/w"]?.mcpServers.l?.args).toEqual(["stdio", "l"]);
    out = "";
    expect(await main(["list"])).toBe(0);
    expect(out.split("\n").filter(Boolean)).toHaveLength(3);
    out = "";
    expect(await main(["eject", "--host", "all"])).toBe(0);
    expect(out).toContain("restored 1 (g)");
    expect(out).toContain("restored 1 (l)");
    expect(out).toContain("restored 1 (c)");
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))).toEqual({
      mcpServers: { g: { command: "g" } },
      projects: { "/w": { mcpServers: { l: { command: "l" } } } },
    });
    out = "";
    expect(await main(["list"])).toBe(0);
    expect(out).toContain("no registered upstreams");
  });

  it("reports a broken file per target and exits 1; rejects bad options", async () => {
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "mcp.json"), "{ not json");
    expect(await main(["import", "--host", "cursor", "--rewrite", "--no-start"])).toBe(1);
    expect(err).toContain("error:");
    await expect(main(["import", "--host", "cursor", "x"])).rejects.toThrow(
      /takes no server names/,
    );
    await expect(main(["import", "--host", "nope"])).rejects.toThrow(/unknown host/);
    await expect(main(["eject", "--host", "cursor", "-x"])).rejects.toThrow(/unknown option -x/);
    await expect(main(["install", "--host", "claude-desktop", "--project"])).rejects.toThrow(
      /no project-scope/,
    );
    out = "";
    expect(await main(["import", "--host", "claude-desktop", "--transport", "http"])).toBe(0);
    expect(out).toContain("does not accept HTTP entries");
  });

  it("import carries a project's directory over as the working directory, and doctor says what is left", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { direct: { command: "d" } },
        projects: { "/w/app": { mcpServers: { scoped: { command: "s" } } } },
      }),
    );
    expect(await main(["import", "--host", "all", "--rewrite", "--no-start"])).toBe(0);
    const registry = JSON.parse(readFileSync(join(dir, "sayagain", "config.json"), "utf8")) as {
      servers: Record<string, { cwd?: string }>;
    };
    // The host ran it inside the project; the daemon would otherwise start it from its own directory.
    expect(registry.servers.scoped?.cwd).toBe("/w/app");
    expect(registry.servers.direct?.cwd).toBeUndefined(); // a user-scope server has no project to inherit
    expect(out).toContain("sayagain doctor");
    out = "";
    // No daemon in this scratch home: doctor leads with that and exits non-zero.
    expect(await main(["doctor", "--no-probe", "--json"])).toBe(1);
    const findings = JSON.parse(out) as { severity: string; title: string; fix?: string }[];
    expect(findings[0]).toMatchObject({
      severity: "error",
      title: "no daemon is running",
      fix: "sayagain serve --detach",
    });
    expect(findings.some((f) => f.title.includes("without a working directory"))).toBe(false);
  });

  it("classes needs a server the registry knows", async () => {
    await expect(main(["classes", "nope"])).rejects.toThrow(/no server named nope/);
    await expect(main(["classes", "a", "b"])).rejects.toThrow(/one server name, or --all/);
  });

  it("ui --no-open prints the page URL with the token of the running daemon", async () => {
    const daemon = await startDaemon({
      registry: { servers: {} },
      stores: openStores("memory"),
      version: "t",
      listen: "127.0.0.1:0",
      log: () => {},
    });
    try {
      expect(await main(["ui", "--no-open"])).toBe(0);
      expect(out.trim()).toBe(
        `http://127.0.0.1:${daemon.port}/ui?token=${encodeURIComponent(daemon.token)}`,
      );
    } finally {
      await daemon.close();
    }
  });
});
