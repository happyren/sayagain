/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" literals are the registry syntax under test */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addServer, loadRegistry, removeServer, resolveEnv } from "./registry.js";

describe("registry", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sayagain-reg-"));
    process.env.SAYAGAIN_HOME = home;
  });
  afterEach(() => {
    process.env.SAYAGAIN_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });
  it("adds, lists, removes and validates names", () => {
    expect(loadRegistry()).toEqual({ servers: {} });
    addServer("notion", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "x"],
      env: { TOKEN: "${NOTION_TOKEN}" },
    });
    addServer("linear", { transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(Object.keys(loadRegistry().servers)).toEqual(["notion", "linear"]);
    expect(() => addServer("bad name", { transport: "stdio", command: "x" })).toThrow(
      /server name/,
    );
    expect(removeServer("notion")).toBe(true);
    expect(removeServer("notion")).toBe(false);
  });
  it("resolves ${VAR} references and blanks unknown ones", () => {
    expect(resolveEnv({ A: "${X}", B: "lit-${Y}", C: "${NOPE}" }, { X: "1", Y: "2" })).toEqual({
      A: "1",
      B: "lit-2",
      C: "",
    });
  });
});
