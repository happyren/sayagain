import { describe, expect, it } from "vitest";
import { buildMeta, classify, META, PROWORD, STATUSES, stripShim, withIntent } from "./index.js";

// MCP `_meta` key grammar: optional reverse-DNS prefix ending in "/", then a name.
const META_KEY =
  /^([a-z][a-z0-9-]*[a-z0-9](\.[a-z][a-z0-9-]*[a-z0-9])*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

describe("META keys", () => {
  it("are valid MCP _meta keys under the sh.sayagain prefix", () => {
    for (const key of Object.values(META)) {
      expect(key).toMatch(META_KEY);
      expect(key.startsWith("sh.sayagain/")).toBe(true);
    }
  });
});

describe("PROWORD", () => {
  it("covers every status", () => {
    for (const s of STATUSES) expect(PROWORD[s]).toBeTruthy();
  });
});

describe("classify", () => {
  it("treats unknown tools as write", () => {
    expect(classify()).toBe("write");
    expect(classify({})).toBe("write");
  });
  it("prefers read-only, then destructive, then idempotent", () => {
    expect(classify({ readOnlyHint: true, destructiveHint: true })).toBe("read-only");
    expect(classify({ destructiveHint: true, idempotentHint: true })).toBe("destructive");
    expect(classify({ idempotentHint: true })).toBe("idempotent-write");
  });
});

describe("buildMeta / withIntent", () => {
  it("omits undefined fields", () => {
    expect(buildMeta({ intent: "close the invoice" })).toEqual({
      "sh.sayagain/intent": "close the invoice",
    });
  });
  it("returns a tools/call params fragment", () => {
    const p = withIntent("create_issue", { title: "x" }, { intent: "file the bug", task: "t1" });
    expect(p.name).toBe("create_issue");
    expect(p.arguments).toEqual({ title: "x" });
    expect(p._meta[META.task]).toBe("t1");
  });
});

describe("stripShim", () => {
  it("moves shim properties into _meta and removes them from arguments", () => {
    const r = stripShim({ title: "x", intent: "file the bug", expect: "issue exists" }, undefined);
    expect(r.arguments).toEqual({ title: "x" });
    expect(r._meta[META.intent]).toBe("file the bug");
    expect(r._meta[META.expect]).toBe("issue exists");
  });
  it("lets native _meta win over shim values", () => {
    const r = stripShim({ intent: "shim" }, { [META.intent]: "native" });
    expect(r._meta[META.intent]).toBe("native");
    expect(r.arguments).toEqual({});
  });
  it("leaves non-string intent alone", () => {
    const r = stripShim({ intent: 42 }, undefined);
    expect(r.arguments).toEqual({ intent: 42 });
  });
});
