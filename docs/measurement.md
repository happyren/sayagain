# Measurement plan

This document is pre-registered. The hypotheses, metric definitions and
decision thresholds below were written before any baseline was collected,
so that the numbers cannot be read to fit the product. Changes go through a
pull request that says what changed and why.

## 1. What we are trying to prove

Two claims, in order. The second is worthless without the first.

1. **The problem is real.** Agents in production lose a material amount of
   money and time to tool-call failures, and some of those failures execute
   side effects nobody acknowledged.
2. **The boundary fixes a meaningful share of it.** Placing Say Again
   between agent and tools reduces the cost of failure and the number of
   unacknowledged writes, at an overhead the workload can afford.

Everything below is a measure of one of those two claims.

## 2. Hypotheses and what would falsify them

| Id | Hypothesis | Falsified if |
| -- | ---------- | ------------ |
| H1 | Tool-call failures are frequent enough to matter | M1 below 2% on MCP tools across two weeks of real traffic |
| H2 | Failures are expensive | M5 below $0.02 per failure and M6 below 3% of session tokens |
| H3 | A boundary can act on a large share of failures | M7 addressable share below 40% |
| H4 | Agents double-fire and lose track of writes | M8 and M9 both zero across two weeks |
| H5 | Agents will state intent when asked | M12 fill rate below 60% on any two of five model families |
| H6 | The boundary reduces cost without breaking the workload | Post-build M15: tokens saved per 1K calls not distinguishable from zero, or overhead p99 above 25 ms on local transport |

## 3. Metric catalogue

Units are per 1,000 tool calls unless stated. "Source" says where the number
comes from: **T** = Claude Code transcripts (`scripts/baseline/claude-code-baseline.mjs`),
**W** = MCP wire tap (`scripts/baseline/mcp-tap.mjs`), **L** = the proxy's
own ledger (`sayagain report`, `tools`, `errors`; recovery cost in bytes on the wire), **X** = a designed experiment.

### Problem metrics

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M1 | Failure rate | `tool_result.is_error` (or JSON-RPC error / `isError`) divided by calls, excluding user interrupts. Reported overall, per tool, per server. | T, W, L |
| M2 | Retry rate | Failures followed by a call to the same tool within the next 3 assistant turns, divided by failures. Also retries per failure. | T, W, L |
| M3 | Identical-retry rate | Retries whose arguments hash to the same value as the failed call. These are the retries that cannot succeed. | T, W, L |
| M4 | Loop incidence | Runs of 3 or more consecutive calls with identical tool and argument hash, or 3 or more consecutive failures on one tool. | T, W, L |
| M5 | Recovery cost | Tokens (uncached input, cached input, cache creation, output) spent from a failure until the next successful call of the same tool, capped at 10 results. Priced at current list prices per model. Reported as median and mean per failure. | T, L |
| M6 | Failure tax | Share of a session's total tokens that fall inside recovery windows. | T, L |
| M7 | Addressable share | Distribution of failures across classes: `retryable` (timeout, rate limit), `coercible` (schema, type, missing required), `semantic` (not found, stale precondition, conflict), `blocked` (permission, auth), `other`. Addressable = retryable + coercible + semantic. | T, W, L |
| M8 | Duplicate-write rate | Non-read-only calls whose tool and argument hash repeat within the next 5 calls of the same session. | T, W, L |
| M9 | Unacknowledged writes | Non-read-only calls with no result, a timeout, or an interrupt. The caller does not know whether the world changed. | T, W, L |
| M10 | Ended on failure | Sessions whose last tool call failed and was never retried. A proxy for abandonment. | T, L |
| M11 | Tool latency | p50 and p95 from request to result, per tool. Sets the overhead budget for M15. | T, W, L |

### Tool-health metrics (the learning loop, ADR-0007)

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M17 | Turns to recover | Assistant turns between a failure and the next success of the same tool in the task, capped at 10 and reported with the unrecovered share. Median per tool and per error signature. The error-message quality proxy. | T, W, L |
| M18 | Waste per 1K calls | Recovery cost summed over a tool's failures, divided by its calls, times 1,000. Ranks tools prone to being mis-called. Also annualised at the observed rate. | T, L |
| M19 | Mis-call rate | Failures classed `coercible` or `semantic` divided by calls: the share that is the tool contract's fault rather than the environment's. | T, W, L |
| M20 | Recovery path and shape change | Per error signature, the most common sequence of tools between failure and success, and the most common change in argument keys or types. Evidence for cross-tool dependencies and for learned coercions. | T, L |
| M21 | Intervention lift | For each learned intervention, failure rate and M17 before and after on the same tool, with the sample size. Reverted automatically when lift is absent. | L |
| M22 | Dead schema tokens | Schema tokens per turn spent on tools never successfully called in the window. | L |

### Intent metrics (experiment before Layer 1)

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M12 | Shim fill rate | Share of non-read-only calls where the injected `intent` property is present and non-empty, per model family. | X |
| M13 | Intent quality | Share of filled intents that describe purpose rather than mechanism, graded by a rubric (two graders, one human, one model; report agreement). | X |
| M14 | Intent-call agreement | Share of calls a grader judges consistent with the stated intent. The complement is the drift base rate, needed before any drift alert can be tuned. | X |

### Product metrics (after Layer 0 ships)

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M15a | Retries avoided | Failures the boundary resolved without a model round trip (deterministic repair or retry) divided by failures. | L |
| M15b | Tokens saved | Sum over avoided retries of the recovery cost the failure would have carried, using the session's own M5 as the counterfactual. | L |
| M15c | Calls held | Non-read-only calls held, and the split of operator decisions: approved, rejected, expired. A held call later rejected is a prevented side effect. | L |
| M15d | Replays | Operator replays, and whether the replay succeeded. | L |
| M15e | Overhead | Boundary latency p50 and p99 on pass-through calls, separately for local and network transport. `scripts/bench/overhead.mjs` measures the local case; the network case waits for a remote upstream. | L |
| M15f | Task success | Share of tasks that end without a dead-lettered call, with and without the boundary. | L, X |

### Ecosystem metrics (linter)

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M16 | Registry constraint gap | Headline: the share of graded registry tools with a `params/constrained` finding (no documented parameter constraints), with the rule-set version. Beside it: the letter-grade distribution and the shares with `output/described` and `annotations/present` findings. Amended 2026-09-05 from "share of tools that document constraints, output and annotations": one negative headline, the rest diagnostic. | X |

## 4. North star

Two numbers, one for risk and one for cost:

- **Unacknowledged writes** per 1,000 writes: M9. Once Layer 1 runs, the
  intent-versus-action rate (the complement of M14) stands beside it.
- **Failure tax in dollars** per 1,000 calls: M5 summed over failures,
  divided by calls.

The product exists to push both down. Everything else is diagnostic.

Amendment, 2026-09-05: the order was cost then risk until the roadmap
adjustment of that date. The headline is intent versus action at the
boundary; cost is a dashboard metric and a trial justification. No metric
definition changed and both numbers stay reported wherever they were.

## 5. Protocols

### 5.1 Baseline from Claude Code transcripts (today, zero build)

```bash
node scripts/baseline/claude-code-baseline.mjs --since 2026-08-01 --json baseline.json
```

Reads every session under `~/.claude/projects`, computes M1 to M11 and
prints a summary. It never outputs argument values, file contents, tool
results or prompts; only tool names, counts, token totals, timestamps,
argument shapes and masked signatures. Keep `baseline.json` out of the
repository.

Since 0.10, `sayagain audit` runs the 0.6 analysis over the same
transcripts (and Codex and Cursor ones) with the definitions in section 3,
prints the section 6 page risk first, and writes a shareable HTML page.
The script stays as the pre-registered instrument behind the baseline
numbers quoted in the build brief. Differences from the script: `audit`
reports M9 per 1,000 writes (the script per 1,000 calls); it classes an
MCP tool whose name carries no recognised verb as a write, as the boundary
does without annotations, and says how many calls that affected (the
script leaves such tools out of the write counts); it recognises more
verbs and a destructive class; it counts M17 in calls between failure and
recovery rather than assistant turns; and it does not split duplicates by
Bash and non-Bash.

Caveat: Claude Code transcripts mix built-in tools with MCP tools. Report
both, but the product claim rests on the MCP subset and on the `Edit` and
`Bash` failure classes that look like MCP failures (stale precondition,
timeout).

### 5.1a Tool-health report (today, zero build)

The same analyzer prints a tool-health section: tools ranked by M18 with
M17, M19 and the top error signatures, recovery paths and shape changes
(M20). Signatures are masked error text and stay on the machine; the JSON
output is for the operator, not for sharing. This is the Databricks
"which tool errors recur most, and how many turns to recover" query run
against your own history.

### 5.2 Wire tap for other agents (two weeks)

Wrap each stdio MCP server the agent uses:

```bash
node scripts/baseline/mcp-tap.mjs --log ./tap-github.jsonl -- npx @modelcontextprotocol/server-github
```

The tap forwards bytes unchanged and writes one line per JSON-RPC message
with method, tool name, argument key names, error flag, byte size and
latency. Run it under quantbot and the delivery flywheel for two weeks, then
feed the logs to the same analyzer with `--tap`.

### 5.3 Shim fill-rate experiment (before Layer 1)

- 40 tasks that each require at least one non-read-only call, drawn from
  real sessions with details changed.
- Five model families: Claude, GPT, Gemini, and two open-weight models one
  of which is under 10B parameters.
- Two conditions: stock tool list, and the same list with the schema shim
  applied to non-read-only tools.
- Measure M12, M13, M14 per model. Grade with a rubric; report inter-grader
  agreement.
- Pre-registered threshold: H5 holds if fill rate is at or above 60% for at
  least three families and quality is at or above 70% of filled intents.

### 5.4 Layer 0 A/B (after the proxy runs)

- Same agents, same tools, the proxy toggled per task by a coin flip logged
  in the ledger.
- Minimum two weeks or 2,000 tool calls per arm, whichever is later.
- Primary outcome M15b tokens saved per 1K calls; secondary M15c, M15f,
  M15e.
- Report the confidence interval, not only the point estimate. With the
  variance seen in run-to-run token totals, expect to need the full sample.

Amendment, 2026-09-06 (0.13.0, ADR-0011). Changed by this amendment, and
why:

- The arms are inside the boundary. `sayagain serve --arm coinflip`
  assigns each host session (one MCP connection; the ledger has no task
  boundary unless the host sends one) to control or treatment by coin;
  `--arm daily` hashes the UTC date so every session of a day lands in
  the same arm and a day can be joined to a transcript audit. The control
  arm forwards every call as it came and records it: no hold, dedupe,
  retry, repair, learned coercion, hint, description augmentation,
  guidance text or announcement. Every ledger row carries its arm.
- The primary cost outcome is the section-4 failure tax as a between-arm
  difference, recovery bytes per call, control minus treatment (positive
  favours the boundary), instead of M15b: a difference between arms needs
  no counterfactual, and the ledger sees bytes, not tokens. M15b in
  tokens comes from `sayagain audit` per arm-day when `--arm daily` is
  used.
- M9 unacknowledged writes per 1,000 writes is the primary risk outcome
  (ADR-0009 decision 2) and is read first.
- The failure rate (M1) replaces M15c and M15f as the secondary outcome:
  M15c is printed per arm, and M15f is degenerate because the control arm
  never dead-letters. M15e (overhead) is not measurable by this design,
  since both arms pass through the proxy; it stays with
  `scripts/bench/overhead.mjs`.
- Intervals: Newcombe's hybrid score interval for the rates, a normal
  interval on Welch's standard error for the per-call tax. Both treat
  calls as independent; `report --ab` prints the number of sessions
  (clusters) per arm so a borderline result is read with that in mind.
  "Distinguishable" means the 95% interval excludes zero; it is not a
  test at a stated alpha, and the three intervals are not corrected for
  one another.
- Decision rule, read once at the minimum: the proof passes if the risk
  interval excludes zero in the boundary's favour and the cost interval
  does not exclude zero against it. The report may be printed earlier;
  interim readings neither stop nor extend the experiment.
- The minimum is unchanged: two weeks or 2,000 calls per arm, whichever
  is later; the verdict checks both.
- Known weaknesses, stated: there is no blinding (the operator, who is
  also the agents' user, can see the arm); the operator's hold decisions
  are part of the treatment; the measured effect is the whole
  intervention, mechanical actions and model-facing text together; the
  treatment keeps learning during the experiment, from treatment rows
  only; `daily` is predictable and confounded with day-of-week and
  workload, so `coinflip` is the default.

Amendment, 2026-09-06 (0.15.0), written before the experiment has any data:
the ledger held nine rows, all from commissioning, when these figures were
computed, so nothing here is chosen with an outcome in view.

**Instrument.** Every figure below comes from source T, the Claude Code
transcripts, read by the same code `sayagain audit` uses (`scanTranscripts`
then `sessionRows`, then the section 3 analysis), over the 30 days to
2026-09-06, restricted to the servers the boundary can wrap. Bytes there are
the transcript's record of a call and its result, which is a proxy for the
wire bytes source L will record once the ledger fills; the two are not the
same instrument and the proxy is the one these numbers rest on.

**The rate.** This machine made 3,874 MCP calls in the window. 1,418 went to
servers the boundary can wrap (docent 1,367, codegraph 50, pencil 1); the
rest belong to servers the host provides itself, which no host file names and
`import` cannot reach. The boundary sees about 47 calls a day, 24 per arm, so
2,000 calls per arm arrives in about 85 days rather than the four weeks the
runbook assumed. The population is docent-dominated: this measures the
boundary on one server's traffic, and the whitepaper has to say so.

**Calls are not the sample size.** The coin is flipped per session, and those
1,418 calls arrived in 21 sessions, a mean of 67 calls each. Failures come in
runs within a session: the intraclass correlation of the failure flag is
0.13, giving a design effect near ten, so a call is worth about a tenth of an
independent observation for anything counted as a rate. Simulating the
pre-registered analysis under a true null with that clustering, a rate
interval that ignores it covers at 0.47 against a nominal 0.95 and declares
the boundary a winner 27% of the time. Widening the interval by the design
effect restores coverage to 0.97 and the false rate to 0.02. The recovery-byte
series does not cluster (its intraclass correlation is about zero: the spread
within a session swamps the differences between sessions), so the failure tax
is unaffected.

**What the sample can and cannot answer**, with the clustering counted
(failure rate 3.5%, unacknowledged writes 8 per 1,000 writes, recovery bytes
per call mean 47,126 and standard deviation 422,990), at 95% and 80% power:

| calls per arm | days | failure tax | unacknowledged writes | failure rate |
|---|---|---|---|---|
| 2,000 | 85 | a 80% cut | nothing detectable | nothing detectable |
| 4,000 | 169 | a 56% cut | nothing detectable | an 81% cut |
| 20,000 | 846 | a 25% cut | an 81% cut | a 42% cut |

So this experiment, on this machine, can speak to the failure tax and cannot
speak to M9, the north-star risk metric, on any timescale worth waiting for.
That is a finding about the design, not about the boundary, and it is
recorded here rather than discovered in December. The organic A/B continues,
pre-registered as a test of the failure tax alone; the risk claim needs
either a workload with many more independent sessions (protocol 5.2) or a
fixture harness where each task is its own cluster (the shape of 5.3).

**Changed by this amendment:**

- The stopping rule is 2,000 calls per arm or 12 weeks of armed traffic,
  whichever is later. `sayagain report --ab` prints the fill rate and the
  date the target is met, after a fortnight of armed calls, measured against
  elapsed time rather than the span between the first and last call.
- Rate intervals carry the design effect measured from the ledger's own
  sessions. The report prints the session count, the correlation and the
  design effect beside them.
- The failure tax keeps its normal interval as the primary, which simulation
  puts at 0.95 coverage for this shape at this sample size. A cluster
  bootstrap over sessions is printed beside it as a check on whether the
  clustering changes the answer; it is not the primary, because the quantity
  it corrects for is not present in this outcome.
- The failure tax is also reported as its two factors, the failure rate and
  the bytes a failure costs, which move for different reasons.
- Nothing else changes: the outcomes, their order, the sign convention, the
  decision rule and the arms are as amended earlier on 2026-09-06.

### 5.6 Fault-injection harness (each task its own cluster)

Pre-registered 2026-09-06 and amended the same day, three times. The
first version of this instrument was wrong in four ways that all flattered
the boundary, found by review before anything was published: the stand-in
operator was never wired to the event the boundary emits, so no held call
was ever decided; a held response carries `isError: false`, so the agent
scored it as a successful write; the treatment arm silently declined work
and nothing counted work left undone; and the metric named for M9 measured
a world-side quantity while M9 is defined caller-side. The second version
injected only the failures the boundary was built for, at about twice the
measured rate, so its headline was a claim about a setting. The third
injected the measured mix but let the boundary's own read-backs through
unfaulted, so they were an oracle inside an instrument about failing
reads; scored a write that came back STANDBY as resolved; and scored a
delete whose retry was told the record was gone as a silent unknown. Each
favoured one arm, and each was found by review before its numbers were
written down. The instrument described here is the fourth, and every
outcome is reported in both directions.

The 5.4 A/B flips its coin per session, and one developer produces about
twenty independent sessions a month, so the outcomes that cluster inside a
session cannot be measured there in a useful time. This protocol buys
independence instead of waiting for it: each task is its own cluster, and the
same task runs twice against the same seeded faults, once through the boundary
and once past it.

```bash
node scripts/experiment/harness.mjs --tasks 60 --seeds 1,2,3,7,11 --operator approve|reject|absent
```

- **The faults** are drawn per step from the failure-class mix the 30-day
  audit measured on this machine's MCP traffic (197 failures): `other` 45%,
  an error nothing downstream can class or act on, which persists on retry;
  `semantic` 26%, a precondition that does not hold, injected as a call
  aimed at a record that does not exist; `retryable` 18%, a timeout a second
  attempt survives; `blocked` 6%, a permission the caller lacks; `coercible`
  5%, a number sent as a string. A step fails at the measured 5.1% and, on
  a write that did not otherwise fail, loses its answer once in a hundred
  (`--lost`), which is the case M9 counts. The class is named on the call
  and the server acts on it, so both arms meet the same fault by
  construction, whatever either side does to recover. Each step draws from
  the mix restricted to the classes it can carry (a wrong type needs a
  typed argument, a missing record needs a lookup), with the shares
  renormalised, so the classes keep their proportions and none is turned
  into another. The boundary's own reads and re-sends carry no fault of
  their own and draw one at the server from the same mix at the same rate
  on the same seed (`scripts/experiment/faults.mjs`); a read-back that
  could not fail would be an oracle inside an instrument about failing
  reads. `--mix fixable`
  keeps the earlier versions' mix (timeouts, wrong types and missing
  records only) so the difference the calibration makes can be seen, and
  `--fail-rate` raises the rate when a few hundred tasks need to meet
  enough faults to show a mechanism.
- **The upstream** (`scripts/experiment/fault-server.mjs`) is a real stdio
  MCP server that logs every call it actually ran and every side effect that
  really happened. Its create and delete declare how to read their effect
  back (spec 8.3). `--server "<command>"` puts the chaos shim
  (`scripts/experiment/chaos.mjs`) in front of any other stdio server
  instead: the shim answers the server-side classes from outside, drops a
  good answer for the lost case, learns which tools are writes from the
  server's own `tools/list`, and logs a truth entry when the server
  answered a write without an error, and holds the client's calls until
  its own `tools/list` has answered. Behind a real server the state row
  cannot be read and prints n/a; a tool the server does not annotate is
  taken for a write, and the task list speaks the fault server's
  vocabulary, so a real server needs a task file that speaks its own.
- **The agent** is a fixed recovery policy, not a model: it retries a
  timeout 88% of the time (M2), an error that says nothing half the time,
  a permission error never, repairs a wrong type once, probes once after a
  missing record, and gives a step at most three attempts. The cap is a
  parameter (`--attempts`), because M17 is a median of 0 and a mean of 1.8
  calls to recover and no single cap follows from that. Every coin it flips
  is keyed on the step and the attempt, so the same agent runs in both
  arms. A write that comes back STANDBY, or held for an unknown outcome, is
  one the agent could not resolve; a write whose retry was told the record
  is not there has been told the truth, and is neither believed nor
  unknown.
- **The operator** is a stand-in with one rule, `--operator
  approve|reject|absent`: approve everything at once, decline everything at
  once, or never answer, so a held call waits out the short wait and comes
  back STANDBY. It is part of the treatment, and the three rules give
  different answers, so all three are reported.
- **Seeds** are pre-registered as 1, 2, 3, 7 and 11, pooled. One seed is one
  draw of the fault pattern, and choosing it after seeing results would be
  choosing the result.
- **The build.** Every report names the boundary's package version and a
  hash of the built files that ran, so a number is pinned to a boundary.
- **Outcomes**, paired per task, control minus treatment, with a t interval
  over tasks: writes that happened and nobody knows about, writes the agent
  could not resolve, writes believed that never happened, records left in the
  wrong state, non-idempotent and total duplicate executions, calls the server
  actually ran, calls and bytes spent recovering, failures the agent saw, of
  which the share nothing could act on, calls made, and bytes delivered. All
  thirteen are printed; none is dropped for being unflattering.
- **The placebo.** `--placebo` runs the treatment arm with the boundary in
  its control mode, which forwards and records and does nothing else. Every
  row but the two byte rows, which carry the receipts, must then be exactly
  zero; if one is not, the instrument is measuring itself. It is run beside
  every reported result.
- **The sweep.** `--sweep` runs the grid of operator rule x read-back x
  attempt cap, eighteen cells, and prints each difference as its range
  across them. A headline that holds in every cell is a claim about the
  boundary; one that holds in some is a claim about a setting.
- **The dump.** `--dump <file>` writes every task's fault draw and both
  arms' rows, one JSON line per task, so a single surprising row can be
  found and reproduced.

**Result at the measured rate, 300 paired tasks over the five seeds,
boundary as of 0.18.0.** With an approving operator and the read-back on,
every harm row is unchanged: silent unknowns 0 and 0, writes the agent
could not resolve 0.08 and 0.08, phantom beliefs 0 and 0, records in the
wrong state 0.10 and 0.10, non-idempotent duplicates 0.01 and 0 (three
tasks, not distinguishable). The agent sees 0.32 failures a task against
0.37 and spends 0.44 calls recovering against 0.53, both distinguishable
and both small. Of the failures it sees, 0.19 a task are ones nothing could
act on, in either arm: that is the larger half of the measured mix, and the
boundary does not touch it. The server runs 4.65 calls a task against 4.43,
which is the pre-image read on every held destructive call plus the
verifiers, and the bytes delivered to the agent double, which is the
receipts. The read-back changes nothing at this rate: `--verify off` gives
the same harm and agent-side rows, with the duplicates at 0.01 in both
arms, and the server-calls row loses the 0.22. A declining operator leaves
records in the wrong state 0.28 times a task against 0.10; an absent one
does the same and leaves 0.26 writes a task unresolved against 0.08; all
distinguishable and against the boundary. A destructive call nobody
approves is work not done, and at this rate that is the largest effect the
boundary has. The placebo is zero on every row but the byte rows.

**Result at a stress rate, 30% of steps and one write in ten losing its
answer, same seeds.** This is where the mechanism can be seen. With the
read-back on, non-idempotent duplicates fall from 0.07 a task to 0.01,
distinguishable, and not to zero: the boundary's read-backs meet the same
server as every other call, and a read-back that fails leaves a hold the
operator approves blind. With it off, the duplicates are 0.07 in both
arms. Silent unknowns are zero in both arms at both rates: in this task
model the agent's own retry of a lost delete is told the record is gone,
which is the truth, and the row that was this instrument's headline in
0.17.0 is not the boundary's to claim here. Failures seen fall from 2.30
to 1.81 and calls spent recovering from 3.11 to 2.29; the 1.11 opaque
failures a task are the same in both arms. Records in the wrong state are
0.38 against 0.37 and writes the agent could not resolve 0.43 against 0.39.
The server runs 0.42 more calls a task. A declining operator leaves 0.48
records in the wrong state against 0.38; an absent one the same, and 0.57
writes unresolved against 0.43. The placebo is zero. Under the `fixable`
mix at the same rate, the shape the earlier versions reported comes back,
now labelled as what it is: failures seen 1.50 to 0.20, calls spent
recovering 2.75 to 0.40, records in the wrong state 0.15 to 0.10, writes
unresolved 0.09 to 0, none of it opaque. The same stress run through the
chaos shim, with the fault server behind it as a stand-in, gives the same
harm rows (duplicates 0.07 to 0.01, failures seen 2.30 to 1.81) with the
state row n/a, which is what the shim can and cannot see.

**The sweep, at the stress rate.** Eighteen cells, operator rule by
read-back by attempt cap, 300 paired tasks each. Across every cell: silent
unknowns 0 to 0.01 and phantom beliefs 0, never against the boundary;
non-idempotent duplicates 0.07 to -0.01, never against, distinguishable in
the fifteen cells where the read-back or the cap gives it something to
remove; calls spent recovering 0.37 to 0.74 and failures seen 0.07 to
0.51, in the boundary's favour in every cell; the opaque failures the same
in both arms in every cell. Records left in the wrong state run from 0.02
in the boundary's favour to 0.13 against it, and the twelve cells against
are exactly the declining and absent operators; the writes the agent could
not resolve run from 0.05 in its favour to 0.09 against, and the six cells
against are the same rules at the higher caps. The server-call row runs
from 0.32 in the boundary's favour (its own retries replace the agent's)
to 0.30 against (the pre-image and the verifiers). So the claims that
survive every setting are the ones about duplicates, silent unknowns and
the agent's recovery work; the ones about work left undone are claims
about the operator's rule.

**What the calibrated harness found.** In its first stress run, one task in
300 showed a write believed in the treatment arm that never happened: a
delete of a record whose create had failed timed out, the verifier read the
record as absent, absence was the declared effect, and the boundary
answered the call as executed (seed 11, task 58 of the stress run, found
through `--dump`). That is the mirror error the phantom row exists to
catch, and it was the boundary's. The pre-image (ADR-0013 amendment, spec
v0.1.9) reads the effect while a held call waits for its operator, and a
verifier that finds the effect present afterwards is conclusive only if
the pre-image found it absent. The row is zero in every run since, and the
cost is the 0.2 server calls a task above.

What this protocol can support: a claim about what the boundary does to
the measured failure distribution under a stated recovery policy and a
stated operator rule. What it cannot support: a claim about what real
models do, or about traffic whose mix differs from this machine's. It is
the internally valid half of the pair; 5.4 on organic traffic is the
externally valid half, and neither is the proof alone.

### 5.5 Registry scan (whitepaper launch)

Run `@sayagain/lint` over every server in the public registry that
publishes a tool list. Report M16 with the exact rule set version so the
scan is reproducible. Since 0.11, `sayagain lint --registry` does this:
it lists the registry, asks each server with a Streamable HTTP remote for
its tools without credentials, grades them, and prints the distribution
with `RULE_SET_VERSION`; `--sample <n> --seed <n>` takes a reproducible
random sample of those servers when the full list is too long for one
sitting (the full scan of about 15,000 remotes takes hours and is the
target; a sample is the first published number).

Coverage, stated on the page: only servers publishing a Streamable HTTP
remote are probed; package-only and SSE-only servers are listed but not
probed. Probed servers that answer 401, 403 or 407 or declare a required
secret header (`auth`), answer with a JSON-RPC error (`refused`), do not
answer in time (`unreachable`), answer with something other than MCP
(`not-mcp`) or list no tools (`no-tools`) contribute no tools; a remote at
a private or loopback address is never probed (`skipped`). Deprecated
registry entries are left out of the listing. M16's denominator is
every tool listed by a server with outcome `ok`, tools without parameters
included. The 95% interval treats tools as independent and ignores that
they cluster by server, so the page also gives the number of servers with
at least one such tool and the median share within a server.

The `params/constrained` heuristic, which defines M16: a property is
expected to carry a constraint when its type is number or integer, or when
its name (snake or camel case) ends in an id, date, time, status, type,
kind, mode, format, level, sort, order, role, unit, currency, locale or
timezone word, or its description says "one of", "either", "allowed
values", "must be", "in the form", "ISO 8601" or "format". A change to
that list is a new `RULE_SET_VERSION`.

## 6. Reporting

One page, weekly, in this order: north star pair (risk first), M1 and M7 by server,
M8 and M9 with the tools involved, M5 median and mean, then anything that
moved. The same page becomes the README's "measured on our own agents"
block when the proxy ships.

## 7. What is never measured

Argument values, tool results, prompts, intent text, task text, file paths.
The analyzers hash arguments in memory for duplicate detection and discard
the hash. See ADR-0005.

## 8. Decision links

The stop signals in the build brief map to H1, H2, H5 and M16. If a
hypothesis is falsified, the brief says what to do; this document does not
get edited to rescue it.
