import { describe, expect, it } from "vitest";
import { classFromName, classReport, declaredTools, overridesFrom } from "./classes.js";
import { type DoctorInput, doctorFindings, renderDoctor } from "./doctor.js";

const tool = (name: string, annotations?: Record<string, boolean>) => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
});

describe("classes", () => {
  it("reads a class from the tool's name, destruction anywhere in it", () => {
    expect(classFromName("get_page")).toMatchObject({ toolClass: "read-only", verb: "get" });
    expect(classFromName("searchAllProperties")).toMatchObject({ toolClass: "read-only" });
    expect(classFromName("create_issue")).toMatchObject({ toolClass: "write", verb: "create" });
    expect(classFromName("set_variables")).toMatchObject({ toolClass: "idempotent-write" });
    expect(classFromName("batch_delete_pages")).toMatchObject({ toolClass: "destructive" });
    expect(classFromName("frobnicate")).toBeUndefined();
  });

  it("names the class, its source and what falls back", () => {
    const r = classReport(
      "s",
      declaredTools([
        tool("get_page", { readOnlyHint: true }),
        tool("delete_page", { destructiveHint: true }),
        tool("do_a_thing"), // nothing declared: the cautious fallback carries it
      ]),
      { do_a_thing: "idempotent-write" },
    );
    expect(r.rows.map((x) => [x.tool, x.toolClass, x.source])).toEqual([
      ["get_page", "read-only", "annotation"],
      ["delete_page", "destructive", "annotation"],
      ["do_a_thing", "idempotent-write", "override"],
    ]);
    expect(r.counts).toMatchObject({ "read-only": 1, destructive: 1, "idempotent-write": 1 });
    expect(r.rows[0]?.effect).toContain("retried");
    expect(r.undeclared).toBe(1); // the override does not make the server declare anything
    expect(r.fallback).toBe(0); // but it does take the tool off the cautious default
    expect(r.suggestions).toEqual([]); // an override is the operator's word: never second-guessed
  });

  it("suggests read-only where a reading name is declared destructive, and never lowers on a write verb", () => {
    // The shape a real design server ships: every tool marked destructive, reads included.
    const r = classReport(
      "pencil",
      declaredTools([
        tool("get_screenshot", { readOnlyHint: false, destructiveHint: true }),
        tool("export_nodes", { readOnlyHint: false, destructiveHint: true }),
        tool("batch_design", { readOnlyHint: false, destructiveHint: true }),
      ]),
    );
    expect(r.counts.destructive).toBe(3);
    expect(r.suggestions.map((s) => [s.tool, s.suggestion?.toolClass])).toEqual([
      ["get_screenshot", "read-only"],
    ]);
    expect(r.suggestions[0]?.suggestion?.reason).toContain('name starts with "get"');
    expect(overridesFrom(r)).toEqual({ get_screenshot: "read-only" });
  });

  it("raises an undeclared tool from the fallback and flags a contradiction", () => {
    const r = classReport(
      "s",
      declaredTools([
        tool("delete_everything"), // fallback write, but the name says destruction
        tool("get_thing", { readOnlyHint: true, destructiveHint: true }),
        tool("list_things"), // fallback write, the name says read
      ]),
    );
    expect(r.undeclared).toBe(2);
    expect(r.fallback).toBe(2);
    expect(r.rows[1]?.warning).toContain("both read-only and destructive");
    expect(r.rows[1]?.toolClass).toBe("read-only"); // readOnlyHint wins, as the SDK classifies
    expect(overridesFrom(r)).toEqual({
      delete_everything: "destructive",
      list_things: "read-only",
    });
  });
});

const base: DoctorInput = {
  cliVersion: "0.14.0",
  daemon: { running: true, version: "0.14.0", arm: null },
  hosts: [],
  servers: [],
  ledger: { total: 0, byServer: {} },
};
const titles = (f: ReturnType<typeof doctorFindings>) => f.map((x) => x.title);

describe("doctor", () => {
  it("reports a stopped daemon and a version behind the command line", () => {
    expect(doctorFindings({ ...base, daemon: { running: false } })[0]).toMatchObject({
      severity: "error",
      fix: "sayagain serve --detach",
    });
    const stale = doctorFindings({ ...base, daemon: { running: true, version: "0.13.0" } });
    expect(stale[0]).toMatchObject({ severity: "warning" });
    expect(stale[0]?.title).toContain("0.13.0");
    expect(
      doctorFindings({ ...base, daemon: { running: true, version: "0.14.0", arm: "coinflip" } })[0]
        ?.detail,
    ).toContain("coinflip");
  });

  it("names the servers a host still calls directly, and the one wrapped in a project only", () => {
    const f = doctorFindings({
      ...base,
      hosts: [
        {
          label: "Claude Code",
          host: "claude-code",
          scope: "user",
          file: "/h/.claude.json",
          exists: true,
          servers: ["a", "b"],
          wrapped: ["a"],
        },
        {
          label: "Claude Code",
          host: "claude-code",
          scope: "local",
          file: "/h/.claude.json",
          project: "/w/app",
          exists: true,
          servers: ["c"],
          wrapped: ["c"],
        },
      ],
    });
    expect(titles(f)).toContain("Claude Code (user) calls 1 server directly: b");
    expect(f.find((x) => x.title.includes("directly"))?.fix).toBe(
      "sayagain import --host claude-code --rewrite",
    );
    const only = f.find((x) => x.title.startsWith("c goes through"));
    expect(only).toMatchObject({ severity: "note", fix: "sayagain install --host claude-code c" });
    expect(only?.title).toContain("/w/app");
  });

  it("reports a host that wraps nothing at all", () => {
    const f = doctorFindings({
      ...base,
      hosts: [
        {
          label: "Cursor",
          host: "cursor",
          scope: "user",
          file: "/h/.cursor/mcp.json",
          exists: true,
          servers: ["a"],
          wrapped: [],
        },
      ],
    });
    expect(f.some((x) => x.severity === "error" && x.title.includes("no host routes"))).toBe(true);
  });

  it("warns about a stdio server the daemon starts outside the project its host gave it", () => {
    const f = doctorFindings({
      ...base,
      servers: [{ name: "codegraph", transport: "stdio", projectOrigins: ["/w/app"] }],
    });
    expect(f[1]).toMatchObject({ severity: "warning" });
    expect(f[1]?.title).toContain("without a working directory");
    expect(f[1]?.fix).toContain("--cwd /w/app");
    // With a working directory recorded, nothing to say.
    expect(
      doctorFindings({
        ...base,
        servers: [
          { name: "codegraph", transport: "stdio", cwd: "/w/app", projectOrigins: ["/w/app"] },
        ],
      }).some((x) => x.title.includes("working directory")),
    ).toBe(false);
  });

  it("calls out a server that declares nothing, and reads that are held on every call", () => {
    const undeclared = classReport(
      "codegraph",
      declaredTools([tool("codegraph_status"), tool("codegraph_trace")]),
    );
    const held = classReport(
      "pencil",
      declaredTools([
        tool("get_screenshot", { destructiveHint: true }),
        tool("batch_design", { destructiveHint: true }),
      ]),
    );
    const f = doctorFindings({
      ...base,
      servers: [
        { name: "codegraph", transport: "stdio", projectOrigins: [], classes: undeclared },
        { name: "pencil", transport: "stdio", projectOrigins: [], classes: held },
      ],
      ledger: { total: 5, byServer: { codegraph: 5, pencil: 0 } },
      hosts: [
        {
          label: "Claude Code",
          host: "claude-code",
          scope: "user",
          file: "/h/.claude.json",
          exists: true,
          servers: ["codegraph", "pencil"],
          wrapped: ["codegraph", "pencil"],
        },
      ],
    });
    const declares = f.find((x) => x.title.includes("declares no annotations"));
    expect(declares).toMatchObject({
      severity: "warning",
      fix: "sayagain classes codegraph --suggest",
    });
    expect(declares?.detail).toContain("north-star");
    const reads = f.find((x) => x.title.includes("held on every call"));
    expect(reads).toMatchObject({ severity: "error", fix: "sayagain classes pencil --suggest" });
    expect(reads?.detail).toContain("get_screenshot");
    expect(titles(f)).toContain("no calls recorded for pencil");
  });

  it("says nothing arrived when a wrapped host has no rows, and renders a summary", () => {
    const f = doctorFindings({
      ...base,
      hosts: [
        {
          label: "Claude Code",
          host: "claude-code",
          scope: "user",
          file: "/h/.claude.json",
          exists: true,
          servers: ["a"],
          wrapped: ["a"],
        },
      ],
    });
    expect(titles(f)).toContain("no calls recorded in the last seven days");
    expect(renderDoctor(f)).toContain("nothing to fix.");
    expect(renderDoctor(doctorFindings({ ...base, daemon: { running: false } }))).toContain(
      "1 error, 0 warnings",
    );
    expect(renderDoctor([])).toContain("nothing to fix.");
  });
});
