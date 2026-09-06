// The fault-injection harness (docs/measurement.md 5.6).
//
// Why it exists: the organic A/B flips its coin per session, and one developer produces about
// twenty independent sessions a month, so anything that clusters inside a session cannot be
// measured there in a useful time. Here each task is its own cluster and each task is run twice,
// once through the boundary and once past it, against the same seeded faults. Sixty tasks give
// sixty independent paired observations in a minute.
//
// What it can say: what the boundary does to a stated failure distribution. What it cannot say:
// what real agents do, because the agent here is a fixed policy, not a model. Both halves are
// stated in the report it prints.
//
// Usage: node scripts/experiment/harness.mjs [--tasks 60] [--seed 1] [--json out.json]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MemoryLedger } from "../../packages/proxy/dist/ledger.js";
import { wrap } from "../../packages/proxy/dist/wrap.js";

const SERVER = fileURLToPath(new URL("./fault-server.mjs", import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const TASKS = Number(arg("tasks", 60));
const SEED = String(arg("seed", "1"));
const JSON_OUT = arg("json", null);

// ---------------------------------------------------------------- the agent

/**
 * A fixed recovery policy, not a model. Its numbers come from the transcripts the baseline read
 * (M2 retry rate 88%, M17 a median of 0 and a mean of 1.8 calls to recover), so the control arm
 * spends roughly what a real agent spends. It is deterministic given the seed.
 */
const POLICY = { retryProbability: 0.88, maxAttemptsPerStep: 3 };
/** What the stand-in operator does with every held call: approve or reject. */
const OPERATOR = String(arg("operator", "approve"));

const rng = (seedText) => {
  let a = 0;
  for (let i = 0; i < seedText.length; i++) a = (Math.imul(a, 31) + seedText.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One task: the calls an agent means to make, and the state it means to leave behind. */
function makeTask(i, seed) {
  const rnd = rng(`${seed}:task:${i}`);
  const id = `rec-${i}`;
  const steps = [{ tool: "create_record", args: { id }, write: true }];
  // Sometimes the agent sends a number as a string: the failure a schema can repair.
  steps.push({
    tool: "search_records",
    args: rnd() < 0.3 ? { query: id, limit: "10" } : { query: id, limit: 10 },
    write: false,
  });
  // Sometimes it reads a record it has not created: the failure a precondition check would catch.
  if (rnd() < 0.25) steps.push({ tool: "get_record", args: { id: `missing-${i}` }, write: false });
  steps.push({ tool: "set_status", args: { id, status: "done" }, write: true });
  steps.push({ tool: "get_record", args: { id }, write: false });
  if (rnd() < 0.2) steps.push({ tool: "delete_record", args: { id }, write: true });
  const deleted = steps.some((s) => s.tool === "delete_record");
  return { id: i, steps, wants: deleted ? [] : [{ id, status: "done" }] };
}

/** Run one task against a client, applying the policy to whatever comes back. */
async function runTask(task, call, seed) {
  const rnd = rng(`${seed}:agent:${task.id}`);
  let calls = 0;
  let visibleFailures = 0;
  let bytes = 0;
  // The failure tax as section 4 defines it: what came back on a failed call and on everything the
  // agent did afterwards to get past it. The rest is ordinary traffic.
  let recoveryBytes = 0;
  // The same quantity without the bytes: a receipt on every response makes a byte count favour the
  // arm that stamps nothing, while a count of calls spent recovering is free of that.
  let recoveryCalls = 0;
  const believed = new Set(); // writes the agent was told succeeded

  for (const step of task.steps) {
    let args = { ...step.args };
    let verified = false;
    let recovering = false;
    for (let attempt = 1; attempt <= POLICY.maxAttemptsPerStep; attempt++) {
      const res = await call(step.tool, args);
      calls++;
      bytes += res.bytes;
      if (recovering || res.isError) {
        recoveryBytes += res.bytes;
        recoveryCalls++;
      }
      if (!res.isError) {
        if (step.write) believed.add(`${step.tool}:${step.args.id}`);
        break;
      }
      visibleFailures++;
      recovering = true;
      const text = res.text;
      // The three recoveries a real agent attempts, in the order the transcripts show them.
      if (/must be a number/.test(text) && typeof args.limit === "string") {
        args = { ...args, limit: Number(args.limit) };
        continue;
      }
      if (/not found/.test(text) && !verified) {
        verified = true;
        const probe = await call("search_records", { query: args.id ?? "" });
        calls++;
        bytes += probe.bytes;
        recoveryBytes += probe.bytes;
        recoveryCalls++;
        break; // the precondition does not hold; a real agent moves on
      }
      if (/timed out/.test(text) && rnd() < POLICY.retryProbability) continue;
      break;
    }
  }
  return { calls, visibleFailures, bytes, recoveryBytes, recoveryCalls, believed };
}

// ---------------------------------------------------------------- transports

/** Speak JSON-RPC over a pair of streams and hand back one call at a time. */
function client(write, onLine) {
  let next = 1;
  const waiting = new Map();
  onLine((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const settle = waiting.get(String(msg.id));
    if (!settle) return;
    waiting.delete(String(msg.id));
    settle({ msg, bytes: Buffer.byteLength(line) });
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(String(id), resolve);
      write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    request,
    call: async (name, args) => {
      const { msg, bytes } = await request("tools/call", { name, arguments: args });
      const result = msg.result ?? {};
      const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
      return { isError: Boolean(result.isError) || Boolean(msg.error), text, bytes };
    },
  };
}

const INIT = {
  protocolVersion: "2026-07-28",
  capabilities: {},
  clientInfo: { name: "harness", version: "1" },
};

/** The control arm: the agent talks to the server, with nothing in between. */
async function direct(env, run) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env } });
  let buffer = "";
  const listeners = [];
  child.stdout.on("data", (d) => {
    buffer += d;
    let i = buffer.indexOf("\n");
    while (i !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      for (const l of listeners) l(line);
      i = buffer.indexOf("\n");
    }
  });
  const c = client(
    (s) => child.stdin.write(s),
    (l) => listeners.push(l),
  );
  await c.request("initialize", INIT);
  const out = await run(c);
  child.kill();
  return out;
}

/** The treatment arm: the same agent, the same server, the boundary in between. */
async function throughBoundary(env, run) {
  const input = new PassThrough();
  const output = new PassThrough();
  const ledger = new MemoryLedger();
  const wrapped = wrap({
    command: process.execPath,
    args: [SERVER],
    input,
    output,
    ledger,
    ledgerKind: "memory",
    env: { ...process.env, ...env },
    control: false,
    announce: false,
    learned: false,
    log: () => {},
    // Holds are the mechanism for a write whose outcome nobody knows, so they stay on and the
    // harness stands in for the operator below. holdWaitMs is short because that operator is instant.
    policy: { hold: "destructive", holdWaitMs: 250 },
  });
  // The operator is part of the treatment (ADR-0011). This one decides at once, always the same way,
  // so the arm measures the boundary and a fixed decision rule rather than a person's judgement.
  wrapped.holds.on("hold", (h) => {
    setImmediate(() => wrapped.holds.decide(h.receipt, OPERATOR));
  });
  let buffer = "";
  const listeners = [];
  output.on("data", (d) => {
    buffer += d;
    let i = buffer.indexOf("\n");
    while (i !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      for (const l of listeners) l(line);
      i = buffer.indexOf("\n");
    }
  });
  const c = client(
    (s) => input.write(s),
    (l) => listeners.push(l),
  );
  await c.request("initialize", INIT);
  const out = await run(c);
  input.end();
  await wrapped.done;
  return { ...out, rows: ledger.rows };
}

// ---------------------------------------------------------------- measurement

const truthOf = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** What the world did, against what the agent was told. */
function measure(task, run, truth) {
  const effects = truth.map((e) => `${e.effect}:${e.id}`);
  const counts = new Map();
  for (const e of effects) counts.set(e, (counts.get(e) ?? 0) + 1);
  // Repeating set_status leaves the same status, so a second one costs nothing. Repeating a create
  // or a delete is the duplicate that matters.
  const unsafe = [...counts.entries()]
    .filter(([key]) => !key.startsWith("set_status:"))
    .reduce((a, [, n]) => a + (n - 1), 0);
  const intended = {
    create: "create_record",
    set_status: "set_status",
    delete: "delete_record",
  };
  let unacknowledged = 0;
  for (const [key] of counts) {
    const [effect, id] = key.split(":");
    const tool = intended[effect];
    if (tool && !run.believed.has(`${tool}:${id}`)) unacknowledged++;
  }
  const duplicates = [...counts.values()].reduce((a, n) => a + (n - 1), 0);
  return {
    task: task.id,
    calls: run.calls,
    visibleFailures: run.visibleFailures,
    recoveryBytes: run.recoveryBytes,
    recoveryCalls: run.recoveryCalls,
    bytes: run.bytes,
    effects: effects.length,
    duplicates,
    unsafeDuplicates: unsafe,
    unacknowledged,
  };
}

// ---------------------------------------------------------------- statistics

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Paired difference over tasks: each task is one independent observation, so a t interval fits. */
function paired(control, treatment, key) {
  const d = control.map((c, i) => c[key] - treatment[i][key]);
  const n = d.length;
  const m = mean(d);
  const sd = n > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0;
  const se = n ? sd / Math.sqrt(n) : 0;
  const t = 1.96 + 2.4 / n; // a small-sample widening of the normal quantile
  return {
    control: +mean(control.map((x) => x[key])).toFixed(2),
    treatment: +mean(treatment.map((x) => x[key])).toFixed(2),
    delta: +m.toFixed(2),
    low: +(m - t * se).toFixed(2),
    high: +(m + t * se).toFixed(2),
    distinguishable: m - t * se > 0 || m + t * se < 0,
  };
}

// ---------------------------------------------------------------- the run

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "sayagain-fault-"));
  const arms = { control: [], treatment: [] };
  const boundaryRows = [];
  try {
    for (let i = 0; i < TASKS; i++) {
      const task = makeTask(i, SEED);
      for (const armName of ["control", "treatment"]) {
        const truthPath = join(dir, `${armName}-${i}.jsonl`);
        writeFileSync(truthPath, "");
        // The same seed in both arms, so the same calls meet the same faults.
        const env = { FAULT_SEED: `${SEED}:${i}`, FAULT_TRUTH: truthPath };
        const runner = armName === "control" ? direct : throughBoundary;
        const out = await runner(env, (c) => runTask(task, c.call, SEED));
        if (out.rows) boundaryRows.push(...out.rows);
        arms[armName].push(measure(task, out, truthOf(truthPath)));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const keys = [
    "unacknowledged",
    "unsafeDuplicates",
    "recoveryCalls",
    "recoveryBytes",
    "visibleFailures",
    "calls",
    "bytes",
  ];
  const diffs = Object.fromEntries(keys.map((k) => [k, paired(arms.control, arms.treatment, k)]));
  const report = {
    generatedAt: new Date().toISOString(),
    tasks: TASKS,
    seed: SEED,
    policy: POLICY,
    operator: OPERATOR,
    differences: diffs,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  const label = {
    unacknowledged: "writes it never learned about",
    unsafeDuplicates: "non-idempotent writes run twice",
    recoveryCalls: "calls spent recovering",
    recoveryBytes: "bytes spent recovering",
    visibleFailures: "failures the agent saw",
    calls: "calls the agent made",
    bytes: "bytes delivered in all",
  };
  const lines = [
    `Fault-injection harness: ${TASKS} tasks, seed ${SEED}, each run twice against the same faults (docs/measurement.md 5.6)`,
    "",
    `  ${"per task".padEnd(30)} ${"control".padStart(9)} ${"treatment".padStart(10)} ${"difference".padStart(11)}   95% interval`,
  ];
  for (const k of keys) {
    const d = diffs[k];
    lines.push(
      `  ${label[k].padEnd(30)} ${String(d.control).padStart(9)} ${String(d.treatment).padStart(10)} ${String(d.delta).padStart(11)}   ${d.low} to ${d.high}${d.distinguishable ? "  distinguishable" : ""}`,
    );
  }
  lines.push("");
  lines.push(
    `The agent is a fixed policy (retries a timeout ${Math.round(POLICY.retryProbability * 100)}% of the time, at most ${POLICY.maxAttemptsPerStep} attempts a step), not a model.`,
  );
  lines.push(
    `Held calls are decided by a stand-in operator that always says ${OPERATOR}; the operator is part of the treatment, so the rule is stated rather than hidden.`,
  );
  lines.push(
    "So this measures what the boundary does to a stated failure distribution, not what a model would do with it.",
  );
  lines.push(
    "Bytes in all include the receipt the boundary stamps on every result, which is why that row favours the control arm; the recovery row is the failure tax.",
  );
  lines.push(`Boundary rows written: ${boundaryRows.length}.`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main();
