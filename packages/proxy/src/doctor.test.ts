import { describe, expect, it } from "vitest";
import {
  classFromName,
  classReport,
  declaredTools,
  overridesFrom,
  readsOnly,
  suggestionsOf,
} from "./classes.js";
import { type DoctorInput, doctorFindings, renderDoctor } from "./doctor.js";

const tool = (name: string, annotations?: Record<string, boolean>, description?: string) => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
  ...(description ? { description } : {}),
});
const report = (...tools: ReturnType<typeof tool>[]) => classReport("s", declaredTools(tools));

describe("classes", () => {
  it("reads a class from the tool's name, through a namespace and wherever destruction sits", () => {
    expect(classFromName("get_page")).toMatchObject({ toolClass: "read-only", verb: "get" });
    expect(classFromName("searchAllProperties")).toMatchObject({ toolClass: "read-only" });
    expect(classFromName("mcp__figma__get_page")).toMatchObject({ toolClass: "read-only" });
    expect(classFromName("codegraph_status")).toMatchObject({ toolClass: "read-only" });
    expect(classFromName("create_issue")).toMatchObject({ toolClass: "write", verb: "create" });
    expect(classFromName("set_variables")).toMatchObject({ toolClass: "idempotent-write" });
    expect(classFromName("batch_delete_pages")).toMatchObject({ toolClass: "destructive" });
    expect(classFromName("frobnicate")).toBeUndefined();
  });

  it("keeps a verb that means something else inside a phrase out of the destructive class", () => {
    expect(classFromName("add_drop_shadow")).toMatchObject({ toolClass: "write" });
    expect(classFromName("list_kill_switches")).toMatchObject({ toolClass: "read-only" });
    expect(classFromName("create_drop_zone")).toMatchObject({ toolClass: "write" });
    expect(classFromName("remove_filter")).toMatchObject({ toolClass: "destructive" }); // leading: it is one
    expect(classFromName("get_delete_history")).toMatchObject({ toolClass: "read-only" }); // reading a log
  });

  it("never lowers a tool whose name or description says it changes something", () => {
    const dangerous = [
      "find_and_replace",
      "read_and_clear",
      "read_clear_buffer",
      "get_lock",
      "getLock",
      "check_out_book",
      "resolve_conflict",
      "validate_and_apply",
      "verify_and_charge",
      "preview_deploy",
      "get_delete_history",
    ];
    for (const name of dangerous) {
      expect(readsOnly(name), name).toBe(false);
      expect(suggestionsOf(report(tool(name, { destructiveHint: true })), "lower"), name).toEqual(
        [],
      );
    }
    // The description is the last gate: this name alone would pass.
    expect(readsOnly("get_session", "Acquire a lock on the session and return it.")).toBe(false);
    expect(readsOnly("get_session", "Returns the current session.")).toBe(true);
  });

  it("still lowers the reads a design server wrongly declares destructive", () => {
    const r = classReport(
      "pencil",
      declaredTools([
        tool(
          "get_screenshot",
          { readOnlyHint: false, destructiveHint: true },
          "Returns a screenshot of a node.",
        ),
        tool(
          "find_empty_space_on_canvas",
          { destructiveHint: true },
          "Find empty space in a file.",
        ),
        tool("export_nodes", { destructiveHint: true }, "Export nodes to image files."),
        tool("batch_design", { destructiveHint: true }, "Execute insert and update operations."),
      ]),
    );
    expect(suggestionsOf(r, "lower").map((x) => x.tool)).toEqual([
      "get_screenshot",
      "find_empty_space_on_canvas",
    ]);
    expect(r.suggestions.map((x) => x.tool)).not.toContain("export_nodes"); // a write verb: left alone
    expect(r.rows[0]?.warning).toContain("lowering drops the hold");
  });

  it("names the class, its source and what falls back", () => {
    const r = classReport(
      "s",
      declaredTools([
        tool("get_page", { readOnlyHint: true }),
        tool("delete_page", { destructiveHint: true }),
        tool("do_a_thing"),
      ]),
      { do_a_thing: "idempotent-write" },
    );
    expect(r.rows.map((x) => [x.tool, x.toolClass, x.source])).toEqual([
      ["get_page", "read-only", "annotation"],
      ["delete_page", "destructive", "annotation"],
      ["do_a_thing", "idempotent-write", "override"],
    ]);
    expect(r.undeclared).toBe(1); // the override does not make the server declare anything
    expect(r.fallback).toBe(0); // but it does take the tool off the cautious default
    expect(r.rows[0]?.effect).toContain("retried");
    expect(r.rows[1]?.effect).toContain("held for a decision before it leaves");
    expect(r.suggestions).toEqual([]); // an override is the operator's word: never second-guessed
  });

  it("raises an undeclared tool from the fallback and flags a contradiction", () => {
    const r = report(
      tool("delete_everything"),
      tool("get_thing", { readOnlyHint: true, destructiveHint: true }),
      tool("list_things"),
    );
    expect(r.undeclared).toBe(2);
    expect(r.fallback).toBe(2);
    expect(r.rows[1]?.warning).toContain("both read-only and destructive");
    expect(r.rows[1]?.toolClass).toBe("read-only"); // readOnlyHint wins, as the SDK classifies
    expect(suggestionsOf(r, "raise").map((x) => x.tool)).toEqual(["delete_everything"]);
    expect(suggestionsOf(r, "lower").map((x) => x.tool)).toEqual(["list_things"]);
  });

  it("keeps overrides this listing did not mention, and takes one direction at a time", () => {
    const existing = { purge_workspace: "destructive" as const, list_things: "write" as const };
    // The table is read with the overrides in force, as the command reads it.
    const withOverride = classReport(
      "s",
      declaredTools([tool("delete_everything"), tool("list_things")]),
      existing,
    );
    // A tool absent from this listing (a page not fetched) keeps the class the operator gave it.
    expect(overridesFrom(withOverride, existing).purge_workspace).toBe("destructive");
    expect(overridesFrom(withOverride, existing).list_things).toBe("write");
    const plain = report(tool("delete_everything"), tool("list_things"));
    expect(overridesFrom(plain, {}, ["raise"])).toEqual({ delete_everything: "destructive" });
    expect(overridesFrom(plain, {}, ["raise", "lower"])).toEqual({
      delete_everything: "destructive",
      list_things: "read-only",
    });
  });
});

const base: DoctorInput = {
  cliVersion: "0.14.0",
  daemon: { running: true, version: "0.14.0", arm: null, listen: "127.0.0.1:7777" },
  hosts: [],
  servers: [],
  ledger: { total: 0, byServer: {} },
  probed: true,
};
const host = (over: Partial<DoctorInput["hosts"][number]> = {}) => ({
  label: "Claude Code",
  host: "claude-code",
  scope: "user",
  file: "/h/.claude.json",
  exists: true,
  servers: ["a"],
  wrapped: ["a"],
  ...over,
});
const titles = (f: ReturnType<typeof doctorFindings>) => f.map((x) => x.title);
const find = (f: ReturnType<typeof doctorFindings>, needle: string) =>
  f.find((x) => x.title.includes(needle));

describe("doctor", () => {
  it("reports a stopped daemon, a version behind the command line, and a public address", () => {
    expect(doctorFindings({ ...base, daemon: { running: false } })[0]).toMatchObject({
      severity: "error",
      fix: "sayagain serve --detach",
    });
    const stale = doctorFindings({ ...base, daemon: { running: true, version: "0.13.0" } });
    expect(stale[0]).toMatchObject({ severity: "warning" });
    expect(stale[0]?.title).toContain("0.13.0");
    const open = doctorFindings({
      ...base,
      daemon: { running: true, version: "0.14.0", listen: "0.0.0.0:7777" },
    });
    expect(find(open, "not loopback")).toMatchObject({ severity: "warning" });
    expect(
      find(doctorFindings({ ...base, daemon: { ...base.daemon, arm: "coinflip" } }), "is running")
        ?.detail,
    ).toContain("coinflip");
  });

  it("says when holds are off, and how to turn them on", () => {
    const observe = doctorFindings({
      ...base,
      daemon: { ...base.daemon, holdDefault: "never" },
    });
    expect(find(observe, "holds are off")).toMatchObject({
      severity: "note",
      fix: "sayagain up --hold",
    });
    expect(find(doctorFindings(base), "holds are off")).toBeUndefined();
  });

  it("orders findings by severity", () => {
    const f = doctorFindings({
      ...base,
      daemon: { running: false },
      hosts: [host({ servers: ["a", "b"], wrapped: ["a"] })],
      servers: [{ name: "a", transport: "stdio", projectOrigins: [] }],
      ledger: { total: 1, byServer: { a: 1 } },
      hostRunning: true,
    });
    const rank = { error: 0, warning: 1, note: 2, ok: 3 };
    const seen = f.map((x) => rank[x.severity]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(f[0]?.severity).toBe("error");
  });

  it("names the servers a host still calls directly, once per host and scope", () => {
    const f = doctorFindings({
      ...base,
      servers: [{ name: "a", transport: "stdio", projectOrigins: [] }],
      hosts: [
        host({ servers: ["a", "b"], wrapped: ["a"] }),
        host({ scope: "local", project: "/w/one", servers: ["c"], wrapped: [] }),
        host({ scope: "local", project: "/w/two", servers: ["d"], wrapped: [] }),
      ],
    });
    expect(find(f, "calls a server directly")?.title).toContain("b");
    expect(find(f, "calls a server directly")?.fix).toBe(
      "sayagain import --host claude-code --rewrite",
    );
    const local = find(f, "2 projects"); // two project files, one finding
    expect(local?.title).toContain("c, d");
    expect(titles(f).filter((t) => t.includes("directly"))).toHaveLength(2);
  });

  it("notes a server configured in one project only, without claiming it is bypassed", () => {
    const f = doctorFindings({
      ...base,
      servers: [{ name: "c", transport: "stdio", projectOrigins: [] }],
      hosts: [
        host({ servers: ["a"], wrapped: ["a"] }),
        host({ scope: "local", project: "/w/app", servers: ["c"], wrapped: ["c"] }),
      ],
    });
    const only = find(f, "configured in /w/app only");
    expect(only).toMatchObject({ severity: "note", fix: "sayagain install --host claude-code c" });
    expect(only?.detail).toContain("no entry for it anywhere else");
    expect(only?.detail).not.toContain("directly");
  });

  it("says when nothing is set up at all", () => {
    const empty = doctorFindings({ ...base, hosts: [], servers: [] });
    expect(titles(empty)).toContain("no host configuration file was found");
    expect(titles(empty)).toContain("no server is registered");
    expect(renderDoctor(empty)).not.toContain("nothing to fix.");
  });

  it("prints a runnable fix for a server started outside its project", () => {
    const f = doctorFindings({
      ...base,
      servers: [
        {
          name: "codegraph",
          transport: "stdio",
          command: "codegraph",
          args: ["serve", "--mcp"],
          projectOrigins: ["/w/app"],
        },
      ],
    });
    // The whole command, not a placeholder: `add` replaces the entry it is given.
    expect(find(f, "without a working directory")?.fix).toBe(
      "sayagain add codegraph --cwd /w/app -- codegraph serve --mcp",
    );
    expect(
      doctorFindings({
        ...base,
        servers: [
          { name: "codegraph", transport: "stdio", cwd: "/w/app", projectOrigins: ["/w/app"] },
        ],
      }).some((x) => x.title.includes("working directory")),
    ).toBe(false);
  });

  it("names an environment reference the daemon cannot resolve", () => {
    const f = doctorFindings({
      ...base,
      servers: [
        { name: "linear", transport: "http", projectOrigins: [], unresolvedRefs: ["LINEAR_TOKEN"] },
      ],
    });
    const ref = find(f, "LINEAR_TOKEN");
    expect(ref).toMatchObject({ severity: "warning" });
    expect(ref?.fix).toContain("export LINEAR_TOKEN=");
    expect(ref?.detail).toContain("as though the credential were wrong");
  });

  it("calls out a server that declares nothing, and reads that are held on every call", () => {
    const undeclared = classReport(
      "codegraph",
      declaredTools([tool("codegraph_status"), tool("codegraph_trace")]),
    );
    const held = classReport(
      "pencil",
      declaredTools([
        tool("get_screenshot", { destructiveHint: true }, "Returns a screenshot."),
        tool("batch_design", { destructiveHint: true }, "Applies operations."),
      ]),
    );
    const f = doctorFindings({
      ...base,
      servers: [
        { name: "codegraph", transport: "stdio", projectOrigins: [], classes: undeclared },
        { name: "pencil", transport: "stdio", projectOrigins: [], classes: held },
      ],
      ledger: { total: 5, byServer: { codegraph: 5 } },
      hosts: [host({ servers: ["codegraph", "pencil"], wrapped: ["codegraph", "pencil"] })],
    });
    const declares = find(f, "declares no annotations");
    expect(declares).toMatchObject({
      severity: "warning",
      fix: "sayagain classes codegraph --suggest",
    });
    expect(declares?.detail).toContain("dilute M9");
    const reads = find(f, "held on every call");
    // A name heuristic is not proof, so this never fails a script on its own.
    expect(reads).toMatchObject({ severity: "warning", fix: "sayagain classes pencil --suggest" });
    expect(reads?.detail).toContain("get_screenshot");
    expect(titles(f)).toContain("no calls recorded for pencil");
  });

  it("reports a single silent server, an empty tool list, and an unprobed run", () => {
    const one = doctorFindings({
      ...base,
      servers: [{ name: "only", transport: "stdio", projectOrigins: [] }],
      hosts: [host({ servers: ["only"], wrapped: ["only"] })],
      ledger: { total: 3, byServer: { other: 3 } },
    });
    expect(titles(one)).toContain("no calls recorded for only");
    const none = doctorFindings({
      ...base,
      servers: [
        { name: "s", transport: "stdio", projectOrigins: [], classes: classReport("s", []) },
      ],
    });
    expect(find(none, "listed no tools")).toMatchObject({ severity: "warning" });
    const unprobed = doctorFindings({
      ...base,
      probed: false,
      servers: [{ name: "s", transport: "stdio", projectOrigins: [] }],
    });
    expect(find(unprobed, "classes were not checked")).toMatchObject({
      fix: "sayagain classes --all",
    });
  });

  it("counts calls waiting for a decision, and raises it once one has waited a day", () => {
    const now = Date.parse("2026-09-06T00:00:00Z");
    const fresh = doctorFindings({
      ...base,
      now,
      holds: [{ receipt: "r1", tool: "delete_page", createdAt: now - 60_000 }],
    });
    expect(find(fresh, "waiting for a decision")).toMatchObject({ severity: "note" });
    const old = doctorFindings({
      ...base,
      now,
      holds: [
        { receipt: "r1", tool: "delete_page", createdAt: now - 3 * 86_400_000, orphaned: true },
        { receipt: "r2", tool: "drop_table", createdAt: now - 60_000 },
      ],
    });
    const waiting = find(old, "waiting for a decision");
    expect(waiting).toMatchObject({ severity: "warning", fix: "sayagain holds" });
    expect(waiting?.title).toContain("2 calls");
    expect(waiting?.detail).toContain("waited 3 days");
    expect(waiting?.detail).toContain("lost the host that asked");
  });

  it("summarises what it found", () => {
    const quiet = doctorFindings({
      ...base,
      hosts: [host()],
      servers: [{ name: "a", transport: "stdio", projectOrigins: [] }],
      ledger: { total: 2, byServer: { a: 2 } },
    });
    expect(renderDoctor(quiet)).toContain("nothing to fix.");
    expect(renderDoctor(doctorFindings({ ...base, daemon: { running: false } }))).toContain(
      "1 error, 0 warnings",
    );
    expect(renderDoctor([{ severity: "note", title: "n", fix: "sayagain holds" }])).toContain(
      "nothing is broken; 1 note worth reading.",
    );
  });
});
