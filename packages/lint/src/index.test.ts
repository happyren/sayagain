import { describe, expect, it } from "vitest";
import { grade, lintTool, RULES, type ToolDefinition } from "./index.js";

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
  it("catches contradictory annotations", () => {
    const f = lintTool({
      ...good,
      annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false },
    });
    expect(f.map((x) => x.rule)).toContain("annotations/consistent");
  });
});
