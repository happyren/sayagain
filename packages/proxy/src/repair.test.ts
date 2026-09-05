import { describe, expect, it } from "vitest";
import { repairArguments } from "./repair.js";

const schema = {
  type: "object",
  properties: {
    limit: { type: "number" },
    dry_run: { type: "boolean" },
    filter: { type: "object" },
    ids: { type: "array", items: { type: "string" } },
    tags: { type: "string" },
    page_size: { type: "integer", default: 20 },
    label: { type: "string" },
  },
  required: ["limit", "page_size"],
};

describe("repairArguments", () => {
  it("coerces by schema and records each change", () => {
    const r = repairArguments(
      { limit: "10", dry_run: "true", filter: '{"a":1}', ids: "x", tags: ["a", "b"], label: 5 },
      schema,
    );
    expect(r?.arguments).toEqual({
      limit: 10,
      dry_run: true,
      filter: { a: 1 },
      ids: ["x"],
      tags: "a,b",
      label: "5",
      page_size: 20,
    });
    expect(r?.changes.map((c) => `${c.path}:${c.rule}`)).toEqual([
      "/limit:string-to-number",
      "/dry_run:string-to-boolean",
      "/filter:json-string-to-value",
      "/ids:scalar-to-array",
      "/tags:array-to-comma-string",
      "/label:number-to-string",
      "/page_size:default",
    ]);
  });
  it("renames keys that differ only by case or separators", () => {
    const r = repairArguments({ pageSize: 5, limit: 1 }, schema);
    expect(r?.arguments).toEqual({ page_size: 5, limit: 1 });
    expect(r?.changes[0]).toMatchObject({ path: "/pageSize", rule: "rename", to: "/page_size" });
  });
  it("refuses a second rename onto a property that is already filled", () => {
    const r = repairArguments(
      { page_id: "a", "page-id": "b", limit: 1 },
      { properties: { pageId: { type: "string" }, limit: { type: "number" } } },
    );
    expect(r?.arguments).toEqual({ pageId: "a", "page-id": "b", limit: 1 });
    expect(r?.changes).toHaveLength(1);
  });
  it("returns null when nothing deterministic applies", () => {
    expect(repairArguments({ limit: "abc", page_size: 1 }, schema)).toBeNull();
    expect(repairArguments({ limit: 1, page_size: 1 }, schema)).toBeNull();
    expect(repairArguments("nope", schema)).toBeNull();
    expect(repairArguments({ limit: "1" }, undefined)).toBeNull();
  });
});
