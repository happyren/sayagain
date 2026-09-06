import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/experiment/harness.mjs", import.meta.url));
const server = fileURLToPath(
  new URL("../../../scripts/experiment/fault-server.mjs", import.meta.url),
);
const chaos = fileURLToPath(new URL("../../../scripts/experiment/chaos.mjs", import.meta.url));

/** The columns of the row with this label: control, treatment, difference, then the interval. */
const columns = (out: string, row: string) => {
  const line = out.split("\n").find((l) => l.includes(row)) ?? "";
  return line.replace(row, "").trim().split(/\s+/);
};
const difference = (out: string, row: string) => columns(out, row)[2];

/**
 * The fault-injection harness is a pre-registered instrument (docs/measurement.md 5.6), so it has to
 * keep running and keep answering the same way. A handful of tasks is enough to prove the wiring;
 * the numbers themselves come from a real run with hundreds.
 */
describe("fault-injection harness", { timeout: 300_000 }, () => {
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
      "of which nothing could act on",
      "bytes delivered to the agent",
    ])
      expect(out).toContain(row);
    // The things the report must always say about itself: the mix it injected, and what the
    // agent and the operator are.
    expect(out).toContain("measured mix");
    expect(out).toContain("other 45%");
    expect(out).toContain("is not a model");
    expect(out).toContain("stand-in that answers every held call");
  });

  it("is reproducible, and the operator's rule changes the answer", () => {
    // Twenty tasks of seed 1 carry destructive steps that meet no fault, so the rules can differ.
    const at = ["--tasks", "20", "--seeds", "1"];
    const approve = () => run([...at, "--operator", "approve"]);
    expect(approve()).toBe(approve()); // the same seed gives the same numbers
    const reject = run([...at, "--operator", "reject"]);
    // An operator who declines every held call leaves work undone; one who approves does not. If
    // these ever match, the stand-in has stopped being wired to the boundary.
    expect(difference(approve(), "records left in the wrong state")).not.toBe(
      difference(reject, "records left in the wrong state"),
    );
  });

  it("lets nobody decide, and says so", () => {
    const out = run(["--tasks", "6", "--seeds", "3", "--operator", "absent"]);
    expect(out).toContain("nobody");
    expect(out).toContain("STANDBY");
  });

  it("shows no difference when the boundary only observes: the instrument is not measuring itself", () => {
    const out = run([
      "--tasks",
      "8",
      "--seeds",
      "3",
      "--fail-rate",
      "0.3",
      "--lost",
      "0.1",
      "--placebo",
    ]);
    expect(out).toContain("PLACEBO");
    for (const row of [
      "failures the agent saw",
      "calls the agent spent recovering",
      "non-idempotent writes run twice",
      "records left in the wrong state",
      "writes that happened, unknown to all",
    ]) {
      const line = out.split("\n").find((l) => l.includes(row)) ?? "";
      expect(line, row).not.toContain("distinguishable");
      // The difference column reads 0 when the two arms did the same work.
      expect(difference(out, row), row).toBe("0");
    }
  });

  it("injects the measured mix, whose larger half the boundary cannot act on", () => {
    const measured = run(["--tasks", "12", "--seeds", "5", "--fail-rate", "0.5"]);
    const fixable = run([
      "--tasks",
      "12",
      "--seeds",
      "5",
      "--fail-rate",
      "0.5",
      "--mix",
      "fixable",
    ]);
    expect(fixable).toContain("fixable mix");
    // Under the measured mix the agent meets errors nothing can class; under the fixable mix it
    // never does. The row is the harness's own statement of how much traffic is out of reach.
    const opaque = (out: string) => Number(columns(out, "of which nothing could act on")[0]);
    expect(opaque(measured)).toBeGreaterThan(0);
    expect(opaque(fixable)).toBe(0);
  });

  it("runs the same protocol against any server through the chaos shim", () => {
    expect(existsSync(chaos)).toBe(true);
    const out = run([
      "--tasks",
      "6",
      "--seeds",
      "1",
      "--fail-rate",
      "0.3",
      "--lost",
      "0.2",
      "--server",
      `${process.execPath} ${server}`,
    ]);
    expect(out).toContain("behind the chaos shim");
    // From outside, the server's state cannot be read, so that row is not estimated.
    const state = out.split("\n").find((l) => l.includes("records left in the wrong state")) ?? "";
    expect(state).toContain("n/a");
    // The shim tells reads from writes by asking the server itself, so a read never counts as a
    // write that happened behind the agent's back.
    expect(difference(out, "writes that happened, unknown to all")).not.toBe("2");
    expect(out).toContain("calls the server actually ran");
  });

  it("refuses a setting it cannot use", () => {
    expect(() => run(["--tasks", "1", "--fail-rate", "six"])).toThrow();
    expect(() => run(["--tasks", "1", "--operator", "maybe"])).toThrow();
    expect(() => run(["--tasks", "1", "--mix", "flattering"])).toThrow();
  });
});
