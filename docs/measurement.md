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
own ledger once it exists, **X** = a designed experiment.

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
| M15e | Overhead | Boundary latency p50 and p99 on pass-through calls, separately for local and network transport. `scripts/bench/overhead.mjs` measures it locally. | L |
| M15f | Task success | Share of tasks that end without a dead-lettered call, with and without the boundary. | L, X |

### Ecosystem metrics (linter)

| Id | Metric | Definition | Source |
| -- | ------ | ---------- | ------ |
| M16 | Registry grade distribution | Letter grades from `@sayagain/lint` across the public registry, and the share of tools that document parameter constraints, output, and annotations. | X |

## 4. North star

Two numbers, one for cost and one for risk, both per 1,000 tool calls:

- **Failure tax in dollars**: M5 summed over failures, divided by calls.
- **Unacknowledged writes**: M9.

The product exists to push both down. Everything else is diagnostic.

## 5. Protocols

### 5.1 Baseline from Claude Code transcripts (today, zero build)

```bash
node scripts/baseline/claude-code-baseline.mjs --since 2026-08-01 --json baseline.json
```

Reads every session under `~/.claude/projects`, computes M1 to M11 and
prints a summary. It never outputs argument values, file contents, tool
results or prompts; only tool names, counts, token totals and timestamps.
Keep `baseline.json` out of the repository.

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

### 5.5 Registry scan (whitepaper launch)

Run `@sayagain/lint` over every server in the public registry that
publishes a tool list. Report M16 with the exact rule set version so the
scan is reproducible.

## 6. Reporting

One page, weekly, in this order: north star pair, M1 and M7 by server,
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
