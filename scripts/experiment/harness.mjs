// The fault-injection harness (docs/measurement.md 5.6).
//
// Why it exists: the organic A/B flips its coin per session, and one developer produces about
// twenty independent sessions a month, so anything that clusters inside a session cannot be
// measured there in a useful time. Here each task is its own cluster and each task is run twice,
// once through the boundary and once past it, against the same seeded faults.
//
// What it can say: what the boundary does to a stated failure distribution under a stated recovery
// policy and a stated operator rule. What it cannot say: what real models do. Every outcome is
// reported in both directions, because a boundary can fail by doing too little as easily as by
// doing too much. A held call that nobody decides leaves work undone, and an agent that reads a
// held write as a success is worse off than one told plainly that the call failed.
//
// Usage: node scripts/experiment/harness.mjs [--tasks 60] [--seeds 1,2,3,7,11] [--operator approve|reject]
//                                            [--verify on|off] [--placebo] [--flaky 0.06] [--lost 0.03]
//                                            [--attempts 3] [--json out.json]
//
// --placebo runs the treatment arm with the boundary in its control mode, which forwards and records
// and does nothing else. Every row but the byte counts should then show no difference; if one does,
// the instrument is measuring itself and not the boundary.
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
/** Several seeds, pooled: one seed is one draw of the fault pattern, and choosing it chooses a result. */
const SEEDS = String(arg("seeds", "1,2,3,7,11"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OPERATOR = String(arg("operator", "approve"));
const FLAKY = Number(arg("flaky", 0.06));
const LOST = Number(arg("lost", 0.03));
const ATTEMPTS = Number(arg("attempts", 3));
const VERIFY = String(arg("verify", "on"));
const PLACEBO = process.argv.includes("--placebo");
const JSON_OUT = arg("json", null);
if (VERIFY !== "on" && VERIFY !== "off") throw new Error("--verify must be on or off");
for (const [name, value] of [
  ["flaky", FLAKY],
  ["lost", LOST],
  ["attempts", ATTEMPTS],
  ["tasks", TASKS],
])
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
if (OPERATOR !== "approve" && OPERATOR !== "reject")
  throw new Error("--operator must be approve or reject");

// ---------------------------------------------------------------- the agent

/**
 * A fixed recovery policy, not a model. The retry rate is M2 from the transcripts (88%); the
 * attempt cap is a parameter, because the measured M17 is a median of 0 and a mean of 1.8 calls to
 * recover and no single cap follows from that. `--attempts` shows what the cap is worth.
 */
const POLICY = { retryProbability: 0.88, maxAttemptsPerStep: ATTEMPTS };

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
  const deletes = rnd() < 0.2;
  if (deletes) steps.push({ tool: "delete_record", args: { id }, write: true });
  // The state the task means to leave behind: nothing if it deleted the record, else the record, done.
  return { id: i, steps, wants: deletes ? {} : { [id]: "done" } };
}

const STATUS = "sh.sayagain/status";
const HELD = "sh.sayagain/held";

/**
 * Run one task, applying the policy to whatever comes back. A held call is neither a success nor a
 * plain failure: the boundary is saying the outcome is not known yet. Reading it as either one
 * would be the instrument scoring itself.
 */
async function runTask(task, call, seed) {
  const rnd = rng(`${seed}:agent:${task.id}`);
  let calls = 0;
  let visibleFailures = 0;
  let bytes = 0;
  let recoveryBytes = 0;
  let recoveryCalls = 0;
  const believed = new Set(); // writes the agent was told succeeded
  const unknown = new Set(); // writes whose outcome the agent never learned

  for (const [index, step] of task.steps.entries()) {
    // The fault is drawn on the logical step, so a repair or a retry by either side meets the same one.
    let args = { ...step.args, __step: `${task.id}:${index}` };
    let verified = false;
    let recovering = false;
    const key = `${step.tool}:${step.args.id}`;
    for (let attempt = 1; attempt <= POLICY.maxAttemptsPerStep; attempt++) {
      const res = await call(step.tool, args);
      calls++;
      bytes += res.bytes;
      const held = res.meta?.[STATUS] === "held";
      if (recovering || res.isError || held) {
        recoveryBytes += res.bytes;
        recoveryCalls++;
      }
      if (held) {
        // A "pre" or "repaired" hold was never sent; an "unknown-outcome" hold may have landed.
        if (step.write && res.meta?.[HELD]?.mode === "unknown-outcome") unknown.add(key);
        if (res.isError) visibleFailures++;
        break; // the boundary asked the agent not to repeat it
      }
      if (!res.isError) {
        if (step.write) believed.add(key);
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
        const probe = await call("search_records", {
          query: args.id ?? "",
          __step: `${task.id}:${index}p`,
        });
        calls++;
        bytes += probe.bytes;
        recoveryBytes += probe.bytes;
        recoveryCalls++;
        break; // the precondition does not hold; a real agent moves on
      }
      if (/timed out/.test(text) && rnd() < POLICY.retryProbability) continue;
      // Out of attempts on a write: it was told the call failed, and it does not know whether it did.
      if (step.write) unknown.add(key);
      break;
    }
  }
  return { calls, visibleFailures, bytes, recoveryBytes, recoveryCalls, believed, unknown };
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
      return {
        isError: Boolean(result.isError) || Boolean(msg.error),
        text,
        bytes,
        meta: result._meta,
      };
    },
  };
}

const INIT = {
  protocolVersion: "2026-07-28",
  capabilities: {},
  clientInfo: { name: "harness", version: "1" },
};

const lineReader = (stream, listeners) => {
  let buffer = "";
  stream.on("data", (d) => {
    buffer += d;
    let i = buffer.indexOf("\n");
    while (i !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      for (const l of listeners) l(line);
      i = buffer.indexOf("\n");
    }
  });
};

/** The control arm: the agent talks to the server, with nothing in between. */
async function direct(env, run) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env } });
  const listeners = [];
  lineReader(child.stdout, listeners);
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
    policy: { hold: "destructive", holdWaitMs: 2000, verify: VERIFY === "on" },
    ...(PLACEBO ? { arm: "control" } : {}),
  });
  // The operator is part of the treatment (ADR-0011). This one decides at once and always the same
  // way, so the arm measures the boundary plus a stated rule rather than a person's judgement.
  wrapped.boundary.on("hold", (h) => {
    setImmediate(() => wrapped.holds.decide(h.receipt, OPERATOR));
  });
  const listeners = [];
  lineReader(output, listeners);
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

/** What the world did, against what the agent was told, in both directions. */
function measure(task, run, truth) {
  const counts = new Map();
  const state = new Map();
  for (const e of truth) {
    const key = `${e.effect}:${e.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (e.effect === "create") state.set(e.id, "new");
    else if (e.effect === "set_status") state.set(e.id, e.status);
    else if (e.effect === "delete") state.delete(e.id);
  }
  const tool = { create: "create_record", set_status: "set_status", delete: "delete_record" };
  const happened = new Set(
    [...counts.keys()].map((k) => {
      const [effect, id] = k.split(":");
      return `${tool[effect]}:${id}`;
    }),
  );

  // The world changed, the agent believes it did not, and nothing else knows either: the silent
  // unknown the boundary exists to remove. A held call is unknown too, but it is not silent.
  let silentUnknown = 0;
  for (const key of happened) if (!run.believed.has(key) && !run.unknown.has(key)) silentUnknown++;
  // The agent believes a write landed and it never did: the mirror error, which a boundary that
  // answered optimistically would produce. Counted so the metric set is not one-sided.
  let phantomBelief = 0;
  for (const key of run.believed) if (!happened.has(key)) phantomBelief++;

  // Work the task meant to leave behind and did not. A boundary that held everything would score
  // well on every harm count, and this is the row that says what that costs.
  let workNotDone = 0;
  for (const [id, status] of Object.entries(task.wants))
    if (state.get(id) !== status) workNotDone++;
  for (const id of state.keys()) if (!(id in task.wants)) workNotDone++;

  const unsafeDuplicates = [...counts.entries()]
    .filter(([key]) => !key.startsWith("set_status:"))
    .reduce((a, [, n]) => a + (n - 1), 0);
  const duplicates = [...counts.values()].reduce((a, n) => a + (n - 1), 0);

  return {
    task: task.id,
    silentUnknown,
    unknownOutcome: run.unknown.size,
    phantomBelief,
    workNotDone,
    unsafeDuplicates,
    duplicates,
    upstreamCalls: run.upstreamCalls,
    recoveryCalls: run.recoveryCalls,
    recoveryBytes: run.recoveryBytes,
    visibleFailures: run.visibleFailures,
    calls: run.calls,
    bytes: run.bytes,
  };
}

// ---------------------------------------------------------------- statistics

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Student's t at 95%: honest at the small end, where the tests run. */
const tQuantile = (df) => {
  if (df < 1) return Number.POSITIVE_INFINITY;
  const small = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  if (df <= 10) return small[df - 1];
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  return 1.96;
};

/** Paired difference over tasks: each task is one independent observation, so a t interval fits. */
function paired(control, treatment, key) {
  const d = control.map((c, i) => c[key] - treatment[i][key]);
  const n = d.length;
  const m = mean(d);
  const r = (x) => +x.toFixed(2);
  const plus = d.filter((x) => x > 0).length;
  const minus = d.filter((x) => x < 0).length;
  if (n < 2)
    return {
      control: r(mean(control.map((x) => x[key]))),
      treatment: r(mean(treatment.map((x) => x[key]))),
      delta: r(m),
      low: null,
      high: null,
      distinguishable: false,
      plus,
      minus,
    };
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const low = r(m - tQuantile(n - 1) * se);
  const high = r(m + tQuantile(n - 1) * se);
  return {
    control: r(mean(control.map((x) => x[key]))),
    treatment: r(mean(treatment.map((x) => x[key]))),
    delta: r(m),
    low,
    high,
    // Read off the bounds as printed, so the flag and the interval never disagree.
    distinguishable: low > 0 || high < 0,
    plus,
    minus,
  };
}

// ---------------------------------------------------------------- the run

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "sayagain-fault-"));
  const arms = { control: [], treatment: [] };
  try {
    for (const seed of SEEDS) {
      for (let i = 0; i < TASKS; i++) {
        const task = makeTask(i, seed);
        for (const armName of ["control", "treatment"]) {
          const truthPath = join(dir, `${armName}-${seed}-${i}.jsonl`);
          const callsPath = join(dir, `${armName}-${seed}-${i}.calls`);
          writeFileSync(truthPath, "");
          writeFileSync(callsPath, "");
          // The same seed in both arms, so the same logical step meets the same fault.
          const env = {
            FAULT_SEED: `${seed}:${i}`,
            FAULT_TRUTH: truthPath,
            FAULT_CALLS: callsPath,
            FAULT_FLAKY: String(FLAKY),
            FAULT_LOST: String(LOST),
          };
          const runner = armName === "control" ? direct : throughBoundary;
          const out = await runner(env, (c) => runTask(task, c.call, seed));
          out.upstreamCalls = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).length;
          arms[armName].push(measure(task, out, truthOf(truthPath)));
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const keys = [
    "silentUnknown",
    "unknownOutcome",
    "phantomBelief",
    "workNotDone",
    "unsafeDuplicates",
    "duplicates",
    "upstreamCalls",
    "recoveryCalls",
    "recoveryBytes",
    "visibleFailures",
    "calls",
    "bytes",
  ];
  const diffs = Object.fromEntries(keys.map((k) => [k, paired(arms.control, arms.treatment, k)]));
  const report = {
    generatedAt: new Date().toISOString(),
    tasksPerSeed: TASKS,
    seeds: SEEDS,
    pairs: arms.control.length,
    policy: POLICY,
    operator: OPERATOR,
    verify: VERIFY === "on",
    placebo: PLACEBO,
    faults: { flaky: FLAKY, lost: LOST },
    differences: diffs,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  const label = {
    silentUnknown: "writes that happened, unknown to all",
    unknownOutcome: "writes the agent could not resolve",
    phantomBelief: "writes believed that never happened",
    workNotDone: "records left in the wrong state",
    unsafeDuplicates: "non-idempotent writes run twice",
    duplicates: "any write run twice",
    upstreamCalls: "calls the server actually ran",
    recoveryCalls: "calls the agent spent recovering",
    recoveryBytes: "bytes the agent spent recovering",
    visibleFailures: "failures the agent saw",
    calls: "calls the agent made",
    bytes: "bytes delivered to the agent",
  };
  const lines = [
    `Fault-injection harness: ${arms.control.length} paired tasks (${TASKS} per seed, seeds ${SEEDS.join(",")}), docs/measurement.md 5.6`,
    `Faults: a call fails once then works ${Math.round(100 * FLAKY)}% of the time; a write lands then loses its answer ${Math.round(100 * LOST)}% of the time.`,
    `Agent: retries a timeout ${Math.round(100 * POLICY.retryProbability)}% of the time, at most ${POLICY.maxAttemptsPerStep} attempts a step, and is not a model.`,
    `Operator: a stand-in that answers every held call "${OPERATOR}", at once. Read-back of a lost write before deciding (spec 8.3): ${VERIFY}.`,
    ...(PLACEBO
      ? [
          "PLACEBO: the treatment arm's boundary is in its control mode and does nothing but forward and record. Any difference below, outside the byte rows, is an artifact of this instrument.",
        ]
      : []),
    "",
    `  ${"per task".padEnd(38)} ${"control".padStart(8)} ${"treatment".padStart(10)} ${"difference".padStart(11)}   95% interval        tasks +/-`,
  ];
  for (const k of keys) {
    const d = diffs[k];
    const interval = d.low === null ? "not estimable" : `${d.low} to ${d.high}`;
    lines.push(
      `  ${label[k].padEnd(38)} ${String(d.control).padStart(8)} ${String(d.treatment).padStart(10)} ${String(d.delta).padStart(11)}   ${interval.padEnd(19)} ${d.plus}/${d.minus}${d.distinguishable ? "  distinguishable" : ""}`,
    );
  }
  lines.push("");
  lines.push(
    "A positive difference means the control arm had more of it. On the last three rows more is not worse, it is what the boundary costs.",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

await main();
