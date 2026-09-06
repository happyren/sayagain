import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { startDaemon } from "./daemon.js";
import { openStores } from "./stores.js";
import { PROXY_VERSION } from "./version.js";

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

  it("import carries a project's directory over, and doctor names what is left with a runnable fix", async () => {
    const project = join(dir, "w", "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { direct: { command: "d" } },
        projects: { [project]: { mcpServers: { scoped: { command: "s", args: ["--mcp"] } } } },
      }),
    );
    expect(await main(["import", "--host", "all", "--rewrite", "--no-start"])).toBe(0);
    const configPath = join(dir, "sayagain", "config.json");
    const read = () =>
      JSON.parse(readFileSync(configPath, "utf8")) as {
        servers: Record<
          string,
          { cwd?: string; origins?: Record<string, { project?: string }>; classes?: unknown }
        >;
      };
    // The host ran it inside the project; the daemon would otherwise start it from its own directory.
    expect(read().servers.scoped?.cwd).toBe(project);
    expect(read().servers.direct?.cwd).toBeUndefined(); // a user-scope server has no project to inherit
    expect(Object.values(read().servers.scoped?.origins ?? {})[0]?.project).toBe(project);
    expect(out).toContain("sayagain doctor");

    // A registry written before this version has the origin but no working directory.
    const stripped = read();
    delete (stripped.servers.scoped as { cwd?: string }).cwd;
    writeFileSync(configPath, JSON.stringify(stripped));
    out = "";
    expect(await main(["doctor", "--no-probe", "--json"])).toBe(1);
    const findings = JSON.parse(out) as { severity: string; title: string; fix?: string }[];
    expect(findings[0]).toMatchObject({
      severity: "error",
      title: "no daemon is running",
      fix: "sayagain serve --detach",
    });
    const cwd = findings.find((f) => f.title.includes("without a working directory"));
    // The whole command, so following it does not lose the registration.
    expect(cwd?.fix).toBe(`sayagain add scoped --cwd ${project} -- s --mcp`);
    expect(findings.some((f) => f.title === "tool classes were not checked")).toBe(true);

    // Following it keeps the record import wrote, so eject still works.
    out = "";
    expect(await main(["add", "scoped", "--cwd", project, "--", "s", "--mcp"])).toBe(0);
    expect(out).toContain("kept the record of where it came from");
    expect(Object.values(read().servers.scoped?.origins ?? {})[0]?.project).toBe(project);
    expect(read().servers.scoped?.cwd).toBe(project);

    // Re-importing after the upgrade adopts the directory instead of reporting a conflict.
    out = "";
    expect(await main(["import", "--host", "all", "--no-start"])).toBe(0);
    expect(out).not.toContain("different command or url");
  });

  it("classes and doctor reject arguments they cannot honour", async () => {
    await expect(main(["classes", "nope"])).rejects.toThrow(/no server named nope/);
    await expect(main(["classes", "a", "b"])).rejects.toThrow(/one server name, or --all/);
    await expect(main(["classes", "--all", "--lower"])).rejects.toThrow(
      /only means something with --write/,
    );
    await expect(main(["doctor", "pencil"])).rejects.toThrow(/doctor: takes no arguments/);
    // Without a daemon there is nothing to ask for a tool list, and the message says so.
    mkdirSync(join(dir, "sayagain"), { recursive: true });
    writeFileSync(
      join(dir, "sayagain", "config.json"),
      JSON.stringify({ servers: { s: { transport: "stdio", command: "s" } } }),
    );
    await expect(main(["classes", "--all"])).rejects.toThrow(/no daemon is running/);
  });

  it("up says what it will do first, wraps every host, writes the observe default; down puts it all back", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { g: { command: "g" } } }),
    );
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { c: { url: "https://c/mcp" } } }),
    );
    const config = () =>
      JSON.parse(readFileSync(join(dir, "sayagain", "config.json"), "utf8")) as {
        servers: Record<string, unknown>;
        daemon?: { hold?: string };
      };
    // The plan comes first, and it says a page is coming.
    expect(await main(["up", "--dry-run"])).toBe(0);
    expect(out).toContain("will:");
    expect(out).toContain("/ui");
    expect(out).toContain("observe first");
    expect(out).toContain("[dry-run]");
    expect(out.indexOf("will:")).toBeLessThan(out.indexOf("[dry-run]"));
    expect(out).not.toContain("page: http");
    out = "";
    expect(await main(["up", "--no-start"])).toBe(0);
    expect(config().daemon?.hold).toBe("never");
    expect(Object.keys(config().servers).sort()).toEqual(["c", "g"]);
    const claude = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    expect(claude.mcpServers.g?.args).toEqual(["stdio", "g"]);
    expect(out).toContain("sayagain up --hold");
    out = "";
    // Turning holds on is a second, explicit step, and a later plain run keeps what it finds.
    expect(await main(["up", "--hold", "--no-start"])).toBe(0);
    expect(config().daemon?.hold).toBe("destructive");
    expect(out).toContain("hold destructive calls");
    expect(out).toContain("holds were off; this run turns them on");
    out = "";
    expect(await main(["up", "--no-start"])).toBe(0);
    expect(config().daemon?.hold).toBe("destructive");
    expect(out).not.toContain("observe first");
    out = "";
    expect(await main(["up", "--observe", "--no-start"])).toBe(0);
    expect(config().daemon?.hold).toBe("never");
    expect(out).toContain("holds were on; this run turns them off");
    out = "";
    expect(await main(["down"])).toBe(0);
    for (const file of [".claude.json", join(".cursor", "mcp.json")])
      expect(
        (JSON.parse(readFileSync(join(dir, file), "utf8")) as { mcpServers: unknown }).mcpServers,
      ).toEqual(
        file === ".claude.json" ? { g: { command: "g" } } : { c: { url: "https://c/mcp" } },
      );
    expect(config().servers).toEqual({});
    expect(config().daemon?.hold).toBeUndefined();
    expect(out).toContain("kept");
    expect(out).toContain("no daemon was running");
  });

  it("up against a running daemon reloads it, prints the page, and --hold reaches the boundaries", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { g: { command: "g" } } }),
    );
    const daemon = await startDaemon({
      registry: { servers: {} },
      stores: openStores("memory"),
      version: PROXY_VERSION, // the command's own version, so up reloads it rather than restarting it
      listen: "127.0.0.1:0",
      log: () => {},
    });
    const health = async () =>
      (await (
        await fetch(`${daemon.url}/api/health`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        })
      ).json()) as { hold: string | null };
    try {
      expect(await main(["up"])).toBe(0);
      expect(out).toContain("daemon already running");
      expect(out).toContain(`page: http://127.0.0.1:${daemon.port}/ui?token=`);
      expect((await health()).hold).toBe("never");
      out = "";
      expect(await main(["up", "--hold"])).toBe(0);
      expect((await health()).hold).toBe("destructive");
      expect(out).toContain("holds are on");
    } finally {
      await daemon.close();
    }
  });

  it("keeps holds on while the A/B protocol runs, and calls a change an amendment", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { g: { command: "g" } } }),
    );
    mkdirSync(join(dir, "sayagain"), { recursive: true });
    writeFileSync(
      join(dir, "sayagain", "config.json"),
      JSON.stringify({ servers: {}, daemon: { arm: "coinflip" } }),
    );
    const config = () =>
      JSON.parse(readFileSync(join(dir, "sayagain", "config.json"), "utf8")) as {
        daemon?: { hold?: string; arm?: string };
      };
    expect(await main(["up", "--no-start"])).toBe(0);
    expect(out).toContain("the A/B protocol is on (coinflip)");
    expect(out).toContain("hold destructive calls");
    expect(config().daemon).toMatchObject({ arm: "coinflip", hold: "destructive" });
    out = "";
    expect(await main(["up", "--observe", "--no-start"])).toBe(0);
    expect(out).toContain("amend docs/measurement.md 5.4");
    expect(config().daemon?.hold).toBe("never");
  });

  it("plans to restart a daemon from an older install", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { g: { command: "g" } } }),
    );
    const daemon = await startDaemon({
      registry: { servers: {} },
      stores: openStores("memory"),
      version: "0.0.1",
      listen: "127.0.0.1:0",
      log: () => {},
    });
    try {
      expect(await main(["up", "--dry-run"])).toBe(0);
      expect(out).toContain(
        `5. restart the daemon (0.0.1 to ${PROXY_VERSION}), so the hosts get this version`,
      );
    } finally {
      await daemon.close();
    }
  });

  it("keeps what the running daemon does when it restarts during an experiment, and waits for a live hold", async () => {
    // The author's machine: an experiment on, a hold default an earlier up wrote, and a daemon from
    // an install that never read it. A restart must not move the treatment arm.
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { g: { command: "g" } } }),
    );
    mkdirSync(join(dir, "sayagain"), { recursive: true });
    writeFileSync(
      join(dir, "sayagain", "config.json"),
      JSON.stringify({ servers: {}, daemon: { arm: "coinflip", hold: "never" } }),
    );
    const daemon = await startDaemon({
      registry: { servers: {} },
      stores: openStores("memory"),
      version: "0.0.1",
      listen: "127.0.0.1:0",
      log: () => {},
    });
    try {
      expect(await main(["up", "--dry-run"])).toBe(0);
      expect(out).toContain("hold destructive calls");
      expect(out).toContain(
        "the running daemon (0.0.1) holds destructive calls while config.json says never",
      );
      expect(out).toContain("the restart keeps what the daemon does");
      expect(out).toContain("5. restart the daemon (0.0.1 to");
      out = "";
      // A live call waiting for a decision forbids the restart; an orphaned one does not.
      const now = Date.now();
      daemon.holds.create({
        receipt: "live-1",
        tool: "delete_page",
        toolClass: "destructive",
        reason: "test",
        arguments: {},
        createdAt: now,
        expiresAt: now + 60_000,
        upstream: "u",
        server: "g",
        mode: "pre",
      });
      expect(await main(["up", "--dry-run"])).toBe(0);
      expect(out).toContain("not yet, 1 call waits for a decision");
      expect(out).toContain("sayagain approve|reject <receipt>");
    } finally {
      await daemon.close();
    }
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
