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
  const run = (args: string[]) =>
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 300_000 });

  it("runs both arms and reports every outcome the protocol names", () => {
    expect(existsSync(script)).toBe(true);
    expect(existsSync(server)).toBe(true);
    const out = run(["--tasks", "6", "--seeds", "1"]);
    expect(out).toContain("6 paired tasks");
    for (const row of [
      "writes that happened, unknown to all",
      "writes the agent could not resolve",
      "writes believed that never happened",
      "records left in the wrong state",
      "non-idempotent writes run twice",
      "calls the server actually ran",
      "calls the agent spent recovering",
      "bytes delivered to the agent",
    ])
      expect(out).toContain(row);
    // The two things the report must always say about itself.
    expect(out).toContain("is not a model");
    expect(out).toContain("stand-in that answers every held call");
  });

  it("is reproducible, and the operator's rule changes the answer", () => {
    const approve = () => run(["--tasks", "8", "--seeds", "3", "--operator", "approve"]);
    expect(approve()).toBe(approve()); // the same seed gives the same numbers
    const reject = run(["--tasks", "8", "--seeds", "3", "--operator", "reject"]);
    const numbers = (text: string) =>
      text
        .split("\n")
        .filter((l) => l.includes("records left in the wrong state"))
        .join("");
    // An operator who declines every held call leaves work undone; one who approves does not. If
    // these ever match, the stand-in has stopped being wired to the boundary.
    expect(numbers(approve())).not.toBe(numbers(reject));
  });

  it("shows no difference when the boundary only observes: the instrument is not measuring itself", () => {
    const out = run(["--tasks", "8", "--seeds", "3", "--placebo"]);
    expect(out).toContain("PLACEBO");
    for (const row of [
      "failures the agent saw",
      "calls the agent spent recovering",
      "non-idempotent writes run twice",
      "records left in the wrong state",
    ]) {
      const line = out.split("\n").find((l) => l.includes(row)) ?? "";
      expect(line, row).not.toContain("distinguishable");
      // The difference column reads 0 when the two arms did the same work.
      expect(line.replace(row, "").trim().split(/\s+/)[2], row).toBe("0");
    }
  });

  it("refuses a fault rate it cannot use", () => {
    expect(() => run(["--tasks", "1", "--flaky", "six"])).toThrow();
    expect(() => run(["--tasks", "1", "--operator", "maybe"])).toThrow();
  });
});
