import { describe, expect, it } from "vitest";
import { grade, lintTool, RULE_SET_VERSION, RULES, type ToolDefinition } from "./index.js";

const good: ToolDefinition = {
  name: "create_issue",
  description:
    "Create a GitHub issue in a repository you can write to. Use get_repo first to confirm the repo exists. Returns the new issue number and URL.",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "owner/name, for example acme/api",
        pattern: "^[^/]+/[^/]+$",
      },
      title: { type: "string", description: "Issue title, one line" },
    },
    required: ["repo", "title"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  _meta: {
    "sh.sayagain/compensation": { tool: "close_issue", arguments: { number: "$result.number" } },
    "sh.sayagain/verify": {
      tool: "find_issue",
      arguments: { repo: "$arguments.repo", title: "$arguments.title" },
    },
  },
};

describe("RULES", () => {
  it("have unique ids", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
});

describe("lintTool", () => {
  it("passes a well-documented tool", () => {
    const f = lintTool(good);
    expect(f).toEqual([]);
    expect(grade(f)).toBe("A");
  });
  it("flags the usual omissions", () => {
    const f = lintTool({
      name: "bad name!",
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    const ids = f.map((x) => x.rule);
    expect(ids).toContain("name/format");
    expect(ids).toContain("description/present");
    expect(ids).toContain("params/described");
    expect(ids).toContain("params/required-listed");
    expect(ids).toContain("params/closed");
    expect(ids).toContain("output/described");
    expect(ids).toContain("annotations/present");
    expect(grade(f)).toBe("F");
  });
  it("asks for constraints where a parameter reads as an id, a date, a choice, or a number", () => {
    const f = lintTool({
      ...good,
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "The user's id" },
          status: { type: "string", description: "Filter by status" },
          limit: { type: "integer", description: "How many to return" },
          created_at: { type: "string", description: "ISO 8601 date", format: "date-time" },
          kind: { type: "string", description: "one of these", enum: ["a", "b"] },
          count: { type: "number", description: "A bounded number", minimum: 0, maximum: 10 },
          note: { type: "string", description: "Free text" },
          sortOrder: { type: "string", description: "asc or desc" },
          createdAt: { type: "string", description: "when", format: "date-time" },
          // Pydantic and zod shapes: a reference, a nullable union with its format, an enum branch.
          ref_status: { $ref: "#/$defs/Status", description: "status" },
          updated_at: {
            anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            description: "when",
          },
          mode: { anyOf: [{ enum: ["a", "b"] }, { type: "null" }], description: "mode" },
          deleted_at: { type: ["string", "null"], description: "when", format: "date-time" },
          body: { type: "string", description: "Text in Markdown format" },
          state: { anyOf: [{ type: "string" }, { type: "null" }], description: "state" },
        },
        required: [],
        additionalProperties: false,
      },
    });
    const paths = f.filter((x) => x.rule === "params/constrained").map((x) => x.path);
    expect(paths).toEqual([
      "/properties/user_id",
      "/properties/status",
      "/properties/limit",
      "/properties/sortOrder",
      "/properties/state",
    ]);
    // Definitions the linter cannot read are counted by the caller, not thrown at it.
    const broken = null as unknown as ToolDefinition["inputSchema"];
    expect(() => lintTool({ name: "x", inputSchema: broken })).not.toThrow();
    expect(() =>
      lintTool({ name: "x", inputSchema: { type: "object", properties: { a: broken } } }),
    ).not.toThrow();
    expect(RULES.find((r) => r.id === "params/constrained")?.implemented).toBe(true);
    expect(RULE_SET_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });
  it("asks a write that cannot be repeated to say how it is undone", () => {
    const { _meta, ...bare } = good;
    const ids = lintTool(bare).map((x) => x.rule);
    expect(ids).toEqual(["annotations/compensation", "annotations/verify"]);
    expect(grade(lintTool(bare))).toBe("A"); // informational: the grade does not move
    // Declaring how to read the effect back clears the second; a delete reads it as an absence.
    expect(
      lintTool({
        ...bare,
        _meta: {
          "sh.sayagain/compensation": { none: "cannot be undone" },
          "sh.sayagain/verify": {
            tool: "find_issue",
            arguments: { repo: "$arguments.repo" },
            effect: "absence",
          },
        },
      }),
    ).toEqual([]);
    // A declaration the boundary would refuse is reported, so it is not mistaken for a promise kept.
    const refused = (verify: unknown) =>
      lintTool({ ...bare, _meta: { "sh.sayagain/verify": verify } })
        .filter((x) => x.rule === "annotations/verify")
        .map((x) => x.message);
    expect(refused({ tool: "get_issue", arguments: { number: "$result.number" } })[0]).toContain(
      "cannot resolve",
    );
    expect(refused({ tool: "list_issues", arguments: {} })[0]).toContain("reads nothing");
    expect(refused({ tool: "get_issue", arguments: { id: "$arguments.id" } })[0]).toContain(
      "does not take",
    );
    expect(refused({ tool: "", arguments: { repo: "$arguments.repo" } })[0]).toContain(
      "names no tool",
    );
    // Saying the effect cannot be undone settles compensation; reading it back is still asked for.
    expect(
      lintTool({
        ...bare,
        _meta: { "sh.sayagain/compensation": { none: "an email cannot be unsent" } },
      }).map((x) => x.rule),
    ).toEqual(["annotations/verify"]);
    expect(
      lintTool({
        ...bare,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      }).map((x) => x.rule),
    ).not.toContain("annotations/compensation");
    expect(
      lintTool({
        ...bare,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      }).map((x) => x.rule),
    ).not.toContain("annotations/compensation");
  });
  it("catches contradictory annotations", () => {
    const f = lintTool({
      ...good,
      annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false },
    });
    expect(f.map((x) => x.rule)).toContain("annotations/consistent");
  });
});
