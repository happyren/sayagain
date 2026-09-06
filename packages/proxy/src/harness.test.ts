import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/experiment/harness.mjs", import.meta.url));
const server = fileURLToPath(
  new URL("../../../scripts/experiment/fault-server.mjs", import.meta.url),
);

/**
 * The fault-injection harness is a pre-registered instrument (docs/measurement.md 5.6), so it has to
 * keep running and keep answering the same way. A handful of tasks is enough to prove the wiring;
 * the numbers themselves come from a real run with hundreds.
 */
describe("fault-injection harness", () => {
  it("runs both arms against the same faults and reports paired differences", () => {
    expect(existsSync(script)).toBe(true);
    expect(existsSync(server)).toBe(true);
    const out = execFileSync(process.execPath, [script, "--tasks", "6", "--seed", "harness-test"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out).toContain("Fault-injection harness: 6 tasks");
    // Every outcome the protocol names has to appear, or the report has quietly stopped measuring one.
    for (const row of [
      "writes it never learned about",
      "non-idempotent writes run twice",
      "calls spent recovering",
      "failures the agent saw",
      "bytes delivered in all",
    ])
      expect(out).toContain(row);
    // The two things the report must always say about itself.
    expect(out).toContain("not a model");
    expect(out).toContain("stand-in operator");
  });

  it("is reproducible: the same seed gives the same numbers", () => {
    const run = () =>
      execFileSync(process.execPath, [script, "--tasks", "4", "--seed", "fixed"], {
        encoding: "utf8",
        timeout: 120_000,
      })
        .split("\n")
        .filter((l) => l.includes("failures the agent saw"))
        .join("");
    expect(run()).toBe(run());
  });
});
