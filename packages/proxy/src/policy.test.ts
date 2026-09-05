import { describe, expect, it } from "vitest";
import { parseClassOverrides, shouldHold, ToolClassifier } from "./policy.js";

describe("ToolClassifier", () => {
  it("uses annotations, defaults unknown tools to write, lets overrides win", () => {
    const c = new ToolClassifier({ create_page: "idempotent-write" });
    expect(
      c.learn([
        { name: "echo", annotations: { readOnlyHint: true } },
        { name: "create_page" },
        { name: "delete_page", annotations: { destructiveHint: true } },
        { nope: 1 },
      ]),
    ).toBe(3);
    expect(c.classOf("echo")).toBe("read-only");
    expect(c.classOf("delete_page")).toBe("destructive");
    expect(c.classOf("create_page")).toBe("idempotent-write");
    expect(c.classOf("never_listed")).toBe("write");
  });
});

describe("shouldHold", () => {
  it("holds destructive by default, everything but reads on always, nothing on never", () => {
    expect(shouldHold("destructive", "destructive")).toBe(true);
    expect(shouldHold("write", "destructive")).toBe(false);
    expect(shouldHold("write", "always")).toBe(true);
    expect(shouldHold("read-only", "always")).toBe(false);
    expect(shouldHold("destructive", "never")).toBe(false);
  });
});

describe("parseClassOverrides", () => {
  it("parses tool=class and rejects nonsense", () => {
    expect(parseClassOverrides(["a=destructive", "b=read-only"])).toEqual({
      a: "destructive",
      b: "read-only",
    });
    expect(() => parseClassOverrides(["a=bogus"])).toThrow(/unknown class/);
    expect(() => parseClassOverrides(["=x"])).toThrow(/tool=class/);
  });
});
