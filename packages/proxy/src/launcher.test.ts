import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_PATH, ensureLauncher } from "./launcher.js";
import { PROXY_VERSION } from "./version.js";

describe("launcher", () => {
  let home = "";
  let previous: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sayagain-launcher-"));
    previous = process.env.SAYAGAIN_HOME;
    process.env.SAYAGAIN_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SAYAGAIN_HOME;
    else process.env.SAYAGAIN_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("runs the install that wrote it, and fetches the same version when that install is gone", () => {
    const path = ensureLauncher();
    const text = readFileSync(path, "utf8");
    expect(text).toContain(CLI_PATH);
    expect(text).toContain(`@sayagain/proxy@${PROXY_VERSION}`);
    // The fallback is reached only when the recorded file is missing.
    expect(text.indexOf(CLI_PATH)).toBeLessThan(text.indexOf("npx -y -p"));
    expect(text).toContain(`SAYAGAIN_HOME=${process.platform === "win32" ? home : `'${home}'`}`);
  });
});
