import { describe, expect, it } from "vitest";
import { createProxy, META, PROXY_VERSION } from "./index.js";

describe("proxy surface", () => {
  it("re-exports the spec constants", () => {
    expect(META.receipt).toBe("sh.sayagain/receipt");
    expect(PROXY_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("refuses to pretend it works", () => {
    expect(() => createProxy({ upstream: "http://localhost:3000/mcp" })).toThrow(/pre-alpha/);
  });
});
