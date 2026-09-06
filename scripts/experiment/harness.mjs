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
// The faults are drawn per step from the class mix the 30-day audit measured (`--mix measured`), at
// the failure rate it measured, and named on the call in `__fault`; the fault server, or the chaos
// shim in front of any real server (`--server`), acts on that name. Half of the measured failures
// are ones the boundary cannot class or act on, and they are injected at that share, so the
// boundary is scored against the traffic it will meet and not against the traffic it was built for.
//
// Usage: node scripts/experiment/harness.mjs [--tasks 60] [--seeds 1,2,3,7,11]
//          [--operator approve|reject|absent] [--verify on|off] [--placebo]
//          [--mix measured|fixable] [--fail-rate 0.051] [--lost 0.01] [--attempts 3]
//          [--server "<command>"] [--sweep] [--json out.json] [--dump tasks.jsonl]
//
// --placebo runs the treatment arm with the boundary in its control mode, which forwards and records
// and does nothing else. Every row but the byte counts should then show no difference; if one does,
// the instrument is measuring itself and not the boundary.
// --sweep runs the grid of operator rule x read-back x attempt cap and prints the envelope of each
// difference across it, so a headline is a range and not a point.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MemoryLedger } from "../../packages/proxy/dist/ledger.js";
import { wrap } from "../../packages/proxy/dist/wrap.js";

const FAULT_SERVER = fileURLToPath(new URL("./fault-server.mjs", import.meta.url));
const CHAOS = fileURLToPath(new URL("./chaos.mjs", import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const TASKS = Number(arg("tasks", 60));
/** Several seeds, pooled: one seed is one draw of the fault pattern, and choosing it chooses a result. */
const SEEDS = String(arg("seeds", "1,2,3,7,11"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OPERATOR = String(arg("operator", "approve"));
const VERIFY = String(arg("verify", "on"));
const PLACEBO = flag("placebo");
const MIX = String(arg("mix", "measured"));
const FAIL_RATE = Number(arg("fail-rate", 0.051));
const LOST = Number(arg("lost", 0.01));
const ATTEMPTS = Number(arg("attempts", 3));
const SERVER = arg("server", null);
const SWEEP = flag("sweep");
const JSON_OUT = arg("json", null);
/** Every task's faults and both arms' rows, one JSON line per task, so a single row can be found. */
const DUMP = arg("dump", null);
for (const [name, value] of [
  ["fail-rate", FAIL_RATE],
  ["lost", LOST],
  ["attempts", ATTEMPTS],
  ["tasks", TASKS],
])
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
if (!["approve", "reject", "absent"].includes(OPERATOR))
  throw new Error("--operator must be approve, reject or absent");
if (VERIFY !== "on" && VERIFY !== "off") throw new Error("--verify must be on or off");
if (MIX !== "measured" && MIX !== "fixable") throw new Error("--mix must be measured or fixable");

/**
 * Failure classes as shares of failures. `measured` is this machine's 30-day MCP audit (197
 * failures, docs/measurement.md 5.6); `fixable` is the mix the first cut of this harness injected,
 * kept so the difference the calibration makes can be seen.
 */
const MIXES = {
  measured: { other: 0.45, semantic: 0.26, retryable: 0.18, blocked: 0.06, coercible: 0.05 },
  fixable: { retryable: 0.5, coercible: 0.25, semantic: 0.25 },
};

// ---------------------------------------------------------------- the agent

/**
 * A fixed recovery policy, not a model. The retry rate for a timeout is M2 from the transcripts
 * (88%); an unclassifiable error is retried half the time, a permission error never. The attempt
 * cap is a parameter (`--attempts`), because M17 is a median of 0 and a mean of 1.8 calls to
 * recover and no single cap follows from that.
 */
const POLICY = { retryTimeout: 0.88, retryOther: 0.5, maxAttemptsPerStep: ATTEMPTS };

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

const drawClass = (rnd, mix) => {
  let u = rnd();
  for (const [cls, share] of Object.entries(mix)) {
    if (u < share) return cls;
    u -= share;
  }
  return "other";
};

/** One task: the calls an agent means to make, and the state it means to leave behind. */
function makeTask(i, seed) {
  const rnd = rng(`${seed}:task:${i}`);
  const id = `rec-${i}`;
  const steps = [
    { tool: "create_record", args: { id }, write: true },
    { tool: "search_records", args: { query: id, limit: 10 }, write: false },
    { tool: "set_status", args: { id, status: "done" }, write: true },
    { tool: "get_record", args: { id }, write: false },
  ];
  // One task in five ends by deleting what it made, so the destructive path is exercised.
  const deletes = rnd() < 0.2;
  if (deletes) steps.push({ tool: "delete_record", args: { id }, write: true });
  // The state the task means to leave behind: nothing if it deleted the record, else the record, done.
  return { id: i, steps, wants: deletes ? {} : { [id]: "done" } };
}

/**
 * Give each step its fault, from the seed and the mix, so both arms meet the same one. A class the
 * step cannot carry (a wrong type on a tool with no typed argument, a missing precondition on a
 * create) becomes the mix's most common class instead, so the mix keeps its character: under the
 * measured mix that is an unclassifiable error, under the fixable one a timeout. The agent-side
 * classes are put into the arguments; the server-side ones are named for the server.
 */
function faulted(task, seed, mix) {
  const rnd = rng(`${seed}:faults:${task.id}`);
  const fallback = Object.entries(mix).sort((a, b) => b[1] - a[1])[0][0];
  const steps = task.steps.map((step) => {
    let cls = rnd() < FAIL_RATE ? drawClass(rnd, mix) : "none";
    let args = { ...step.args };
    if (cls === "coercible") {
      if (typeof args.limit === "number") args = { ...args, limit: String(args.limit) };
      else cls = fallback;
    } else if (cls === "semantic") {
      if (step.tool !== "create_record" && args.id !== undefined)
        args = { ...args, id: `missing-${task.id}` };
      else cls = fallback;
    }
    // A lost answer is a separate event on a write, at the rate M9 was measured. It is the case the
    // north-star metric counts, so it is drawn on its own rather than as a share of the failures.
    if (cls === "none" && step.write && rnd() < LOST) cls = "lost";
    const server = ["other", "blocked", "retryable", "lost"].includes(cls) ? cls : "none";
    return { ...step, args, fault: server, cls };
  });
  return { ...task, steps };
}

const STATUS = "sh.sayagain/status";
const HELD = "sh.sayagain/held";

/**
 * Run one task, applying the policy to whatever comes back. A held call is neither a success nor a
 * plain failure: the boundary is saying the outcome is not known yet. Reading it as either one
 * would be the instrument scoring itself.
 */
async function runTask(task, call, seed, policy) {
  const rnd = rng(`${seed}:agent:${task.id}`);
  let calls = 0;
  let visibleFailures = 0;
  let bytes = 0;
  let recoveryBytes = 0;
  let recoveryCalls = 0;
  let opaqueSeen = 0; // failures nothing downstream could act on: the boundary's blind half
  const believed = new Set(); // writes the agent was told succeeded
  const unknown = new Set(); // writes whose outcome the agent never learned

  for (const [index, step] of task.steps.entries()) {
    // The fault is drawn on the logical step, so a repair or a retry by either side meets the same one.
    let args = { ...step.args, __step: `${task.id}:${index}`, __fault: step.fault };
    let verified = false;
    let recovering = false;
    const key = `${step.tool}:${step.args.id}`;
    for (let attempt = 1; attempt <= policy.maxAttemptsPerStep; attempt++) {
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
      // The recoveries a real agent attempts, in the order the transcripts show them.
      if (/must be a number/.test(text) && typeof args.limit === "string") {
        args = { ...args, limit: Number(args.limit) };
        continue;
      }
      if (/not found/.test(text) && !verified) {
        verified = true;
        const probe = await call("search_records", {
          query: args.id ?? "",
          __step: `${task.id}:${index}p`,
          __fault: "none",
        });
        calls++;
        bytes += probe.bytes;
        recoveryBytes += probe.bytes;
        recoveryCalls++;
        break; // the precondition does not hold; a real agent moves on
      }
      if (/timed out/.test(text)) {
        if (rnd() < policy.retryTimeout) continue;
      } else {
        opaqueSeen++;
        // A permission error is never retried; an error that says nothing is retried half the time.
        if (!/permission denied/.test(text) && rnd() < policy.retryOther) continue;
      }
      // Out of attempts on a write: it was told the call failed, and it does not know whether it did.
      if (step.write) unknown.add(key);
      break;
    }
  }
  return {
    calls,
    visibleFailures,
    bytes,
    recoveryBytes,
    recoveryCalls,
    opaqueSeen,
    believed,
    unknown,
  };
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
  clientInfo: { name: "harness", version: "2" },
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

/** The upstream command: the fault server, or the chaos shim in front of the server named. */
const upstream = () =>
  SERVER
    ? { command: process.execPath, args: [CHAOS], env: { CHAOS_SERVER: SERVER } }
    : { command: process.execPath, args: [FAULT_SERVER], env: {} };

/** The control arm: the agent talks to the server, with nothing in between. */
async function direct(env, run) {
  const up = upstream();
  const child = spawn(up.command, up.args, { env: { ...process.env, ...up.env, ...env } });
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
async function throughBoundary(env, run, cell) {
  const input = new PassThrough();
  const output = new PassThrough();
  const ledger = new MemoryLedger();
  const up = upstream();
  const wrapped = wrap({
    command: up.command,
    args: up.args,
    input,
    output,
    ledger,
    ledgerKind: "memory",
    env: { ...process.env, ...up.env, ...env },
    control: false,
    announce: false,
    learned: false,
    log: () => {},
    // An absent operator never decides, so a held call waits out the short wait and comes back STANDBY.
    policy: {
      hold: "destructive",
      holdWaitMs: cell.operator === "absent" ? 250 : 2000,
      verify: cell.verify === "on",
    },
    ...(cell.placebo ? { arm: "control" } : {}),
  });
  // The operator is part of the treatment (ADR-0011). This one decides at once and always the same
  // way, so the arm measures the boundary plus a stated rule rather than a person's judgement.
  if (cell.operator !== "absent")
    wrapped.boundary.on("hold", (h) => {
      setImmediate(() => wrapped.holds.decide(h.receipt, cell.operator));
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
  const idempotent = new Set();
  const state = new Map();
  for (const e of truth) {
    const key = `${e.effect}:${e.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (e.idempotent) idempotent.add(key);
    if (e.effect === "create") state.set(e.id, "new");
    else if (e.effect === "set_status") state.set(e.id, e.status);
    else if (e.effect === "delete") state.delete(e.id);
  }
  const tool = { create: "create_record", set_status: "set_status", delete: "delete_record" };
  const happened = new Set(
    [...counts.keys()].map((k) => {
      const [effect, id] = k.split(":");
      return `${tool[effect] ?? effect}:${id}`;
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
  // well on every harm count, and this is the row that says what that costs. Only the fault
  // server's state can be reconstructed; behind a real server the row is not estimable.
  let workNotDone = null;
  if (!SERVER) {
    workNotDone = 0;
    for (const [id, status] of Object.entries(task.wants))
      if (state.get(id) !== status) workNotDone++;
    for (const id of state.keys()) if (!(id in task.wants)) workNotDone++;
  }

  const unsafeDuplicates = [...counts.entries()]
    .filter(([key]) => !idempotent.has(key))
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
    opaqueSeen: run.opaqueSeen,
    calls: run.calls,
    bytes: run.bytes,
  };
}

// ---------------------------------------------------------------- statistics

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/**
 * Student's t at 95%: exact to ten degrees of freedom, then the value at the smallest df of each
 * bucket, so a bucket never claims a narrower interval than its smallest member is owed.
 */
const tQuantile = (df) => {
  if (df < 1) return Number.POSITIVE_INFINITY;
  const small = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  if (df <= 10) return small[df - 1];
  if (df <= 20) return 2.201; // df 11
  if (df <= 30) return 2.08; // df 21
  if (df <= 60) return 2.04; // df 31
  if (df <= 120) return 2.0; // df 61
  return 1.98;
};

/**
 * Paired difference over tasks: each task is one independent observation, so a t interval fits.
 * A pair where either side is not estimable (null) is left out and n says how many remain.
 */
export function paired(control, treatment, key) {
  const pairs = control
    .map((c, i) => [c[key], treatment[i]?.[key]])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const d = pairs.map(([a, b]) => a - b);
  const n = d.length;
  const r = (x) => +x.toFixed(2);
  const m = mean(d);
  const base = {
    control: r(mean(pairs.map((p) => p[0]))),
    treatment: r(mean(pairs.map((p) => p[1]))),
    delta: r(m),
    plus: d.filter((x) => x > 0).length,
    minus: d.filter((x) => x < 0).length,
    n,
  };
  if (n < 2) return { ...base, low: null, high: null, distinguishable: false };
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const low = r(m - tQuantile(n - 1) * se);
  const high = r(m + tQuantile(n - 1) * se);
  // Read off the bounds as printed, so the flag and the interval never disagree.
  return { ...base, low, high, distinguishable: low > 0 || high < 0 };
}

// ---------------------------------------------------------------- the run

const KEYS = [
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
  "opaqueSeen",
  "calls",
  "bytes",
];
/** The rows where more is not worse but what the boundary costs: their sign is read the other way. */
const COST_KEYS = new Set(["visibleFailures", "opaqueSeen", "calls", "bytes"]);
const LABEL = {
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
  opaqueSeen: "  of which nothing could act on",
  calls: "calls the agent made",
  bytes: "bytes delivered to the agent",
};

/** One configuration, every seed, every task, both arms. */
async function runOnce(cell) {
  const policy = { ...POLICY, maxAttemptsPerStep: cell.attempts };
  const dir = mkdtempSync(join(tmpdir(), "sayagain-fault-"));
  const arms = { control: [], treatment: [] };
  if (DUMP) writeFileSync(DUMP, "");
  try {
    for (const seed of SEEDS) {
      for (let i = 0; i < TASKS; i++) {
        const task = faulted(makeTask(i, seed), seed, MIXES[MIX]);
        const truths = {};
        for (const armName of ["control", "treatment"]) {
          const truthPath = join(dir, `${armName}-${seed}-${i}.jsonl`);
          const callsPath = join(dir, `${armName}-${seed}-${i}.calls`);
          writeFileSync(truthPath, "");
          writeFileSync(callsPath, "");
          const env = { FAULT_TRUTH: truthPath, FAULT_CALLS: callsPath };
          const run = (c) => runTask(task, c.call, seed, policy);
          const out =
            armName === "control" ? await direct(env, run) : await throughBoundary(env, run, cell);
          out.upstreamCalls = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).length;
          truths[armName] = truthOf(truthPath);
          arms[armName].push(measure(task, out, truths[armName]));
        }
        if (DUMP)
          appendFileSync(
            DUMP,
            `${JSON.stringify({
              seed,
              task: i,
              steps: task.steps.map((s) => `${s.tool}=${s.cls}`),
              control: arms.control.at(-1),
              treatment: arms.treatment.at(-1),
              truth: truths,
            })}\n`,
          );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    pairs: arms.control.length,
    differences: Object.fromEntries(KEYS.map((k) => [k, paired(arms.control, arms.treatment, k)])),
  };
}

function render(result, cell) {
  const mix = Object.entries(MIXES[MIX])
    .map(([k, v]) => `${k} ${Math.round(100 * v)}%`)
    .join(", ");
  const lines = [
    `Fault-injection harness: ${result.pairs} paired tasks (${TASKS} per seed, seeds ${SEEDS.join(",")}), docs/measurement.md 5.6`,
    `Faults: ${(100 * FAIL_RATE).toFixed(1)}% of steps fail, classes in the ${MIX} mix (${mix}); a write loses its answer once ${(100 * LOST).toFixed(0)}% of the time.`,
    `Agent: retries a timeout ${Math.round(100 * POLICY.retryTimeout)}% of the time and an unclassifiable error ${Math.round(100 * POLICY.retryOther)}%, never a permission error, at most ${cell.attempts} attempts a step; it is not a model.`,
    `Operator: ${cell.operator === "absent" ? "nobody; a held call waits out the short wait and comes back STANDBY" : `a stand-in that answers every held call "${cell.operator}", at once`}. Read-back of a lost write before deciding (spec 8.3): ${cell.verify}.`,
    ...(SERVER
      ? [
          `Server: ${SERVER}, behind the chaos shim; the state row cannot be read from outside and is n/a.`,
        ]
      : []),
    ...(cell.placebo
      ? [
          "PLACEBO: the treatment arm's boundary is in its control mode and does nothing but forward and record. Any difference below, outside the byte rows, is an artifact of this instrument.",
        ]
      : []),
    "",
    `  ${"per task".padEnd(38)} ${"control".padStart(8)} ${"treatment".padStart(10)} ${"difference".padStart(11)}   95% interval        tasks +/-`,
  ];
  for (const k of KEYS) {
    const d = result.differences[k];
    if (!d.n) {
      lines.push(`  ${LABEL[k].padEnd(38)} ${"n/a".padStart(8)}`);
      continue;
    }
    const interval = d.low === null ? "not estimable" : `${d.low} to ${d.high}`;
    lines.push(
      `  ${LABEL[k].padEnd(38)} ${String(d.control).padStart(8)} ${String(d.treatment).padStart(10)} ${String(d.delta).padStart(11)}   ${interval.padEnd(19)} ${d.plus}/${d.minus}${d.distinguishable ? "  distinguishable" : ""}`,
    );
  }
  lines.push("");
  lines.push(
    "A positive difference means the control arm had more of it. On the last four rows more is not worse, it is what the boundary costs; the two agent-side rows underneath count the same failures either way.",
  );
  return lines.join("\n");
}

/** The sweep: every operator rule, both read-back settings, three attempt caps. */
const GRID = [];
for (const operator of ["approve", "reject", "absent"])
  for (const verify of ["on", "off"])
    for (const attempts of [2, 3, 4]) GRID.push({ operator, verify, attempts, placebo: false });

function envelopeOf(cells) {
  const envelope = {};
  for (const k of KEYS) {
    const ds = cells.map((c) => c.differences[k]).filter((d) => d.n > 0);
    if (!ds.length) continue;
    const deltas = ds.map((d) => d.delta);
    // An interval wholly below zero says the treatment arm had more of the row. On a harm row that
    // is the boundary doing harm; on a cost row it is the boundary's price, which is expected.
    const treatmentMoreIn = ds.filter((d) => d.low !== null && d.high < 0).length;
    envelope[k] = {
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      cells: ds.length,
      distinguishableIn: ds.filter((d) => d.distinguishable).length,
      treatmentMoreIn,
      cost: COST_KEYS.has(k),
    };
  }
  return envelope;
}

function renderSweep(cells, envelope) {
  const lines = [
    `Sweep: ${cells.length} cells (operator x read-back x attempt cap), ${cells[0]?.pairs ?? 0} paired tasks each, ${MIX} mix`,
    "",
    `  ${"per task, difference across the grid".padEnd(42)} ${"min".padStart(8)} ${"max".padStart(8)}   distinguishable   treatment had more`,
  ];
  for (const k of KEYS) {
    const e = envelope[k];
    if (!e) {
      lines.push(`  ${LABEL[k].padEnd(42)} ${"n/a".padStart(8)}`);
      continue;
    }
    lines.push(
      `  ${LABEL[k].padEnd(42)} ${String(e.min).padStart(8)} ${String(e.max).padStart(8)}   ${`${e.distinguishableIn}/${e.cells} cells`.padEnd(17)} ${e.treatmentMoreIn ? `${e.treatmentMoreIn}/${e.cells} cells` : "never"}`,
    );
  }
  lines.push("");
  lines.push(
    "A headline that holds in every cell is a claim about the boundary; one that holds in some is a claim about a setting. On the last four rows the treatment having more is its cost, not a harm.",
  );
  return lines.join("\n");
}

async function main() {
  const stamp = () => new Date().toISOString();
  const common = {
    tasksPerSeed: TASKS,
    seeds: SEEDS,
    policy: POLICY,
    mix: MIX,
    mixShares: MIXES[MIX],
    failRate: FAIL_RATE,
    lost: LOST,
    server: SERVER,
  };
  if (!SWEEP) {
    const cell = { operator: OPERATOR, verify: VERIFY, attempts: ATTEMPTS, placebo: PLACEBO };
    const result = await runOnce(cell);
    if (JSON_OUT)
      writeFileSync(
        JSON_OUT,
        `${JSON.stringify({ generatedAt: stamp(), ...common, ...cell, pairs: result.pairs, differences: result.differences }, null, 2)}\n`,
      );
    process.stdout.write(`${render(result, cell)}\n`);
    return;
  }
  const cells = [];
  for (const cell of GRID) {
    const result = await runOnce(cell);
    cells.push({ cell, pairs: result.pairs, differences: result.differences });
    process.stderr.write(
      `  ${cell.operator.padEnd(8)} verify ${cell.verify.padEnd(4)} attempts ${cell.attempts}: ${result.pairs} pairs\n`,
    );
  }
  const envelope = envelopeOf(cells);
  if (JSON_OUT)
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify({ generatedAt: stamp(), ...common, grid: cells, envelope }, null, 2)}\n`,
    );
  process.stdout.write(`${renderSweep(cells, envelope)}\n`);
}

await main();
