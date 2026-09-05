# ADR-0007: Per-call observability and the learning loop

- Status: Accepted
- Date: 2026-09-04

## Context

Databricks traced every MCP tool invocation through their gateway with
OpenTelemetry, asked two questions of the trace table ("which tool errors
recur most" and "how many turns does recovery take"), and found seven
under-specified tool signatures costing about $499K a year in tokens and
12,000 engineering hours. Cryptic errors took 12 turns to recover; clear
ones took 4 to 5. The fixes were input coercion, defaults and flexible
argument handling, applied in an hour.

Say Again sits at the same point in the path and already keeps the same
record. The requirement is to turn that record into three things: an
observation of every call, a collation that names the tools prone to being
mis-called and why, and a loop that makes the next call in this user's
context more likely to succeed, without a human reading dashboards.

## Decision

### One record per call, exported as a span

The ledger row is the source of truth; OpenTelemetry is the export. Every
`tools/call` produces one span using the GenAI semantic conventions plus
Say Again attributes, so the data lands in whatever the user already runs
(Langfuse, MLflow, Datadog, ClickHouse, Grafana).

| Attribute | Content |
| --------- | ------- |
| `gen_ai.tool.name`, `gen_ai.tool.call.id` | Tool name and the client's call id |
| `mcp.server.name`, `mcp.server.version`, `mcp.method` | From `initialize` and the request |
| `sayagain.receipt`, `sayagain.status`, `sayagain.tool_class` | Spec section 5 |
| `sayagain.error.class` | `retryable`, `coercible`, `semantic`, `blocked`, `other` |
| `sayagain.error.signature` | Masked first line of the error (values, paths, ids and numbers replaced). Local ledger only; exported as `sayagain.error.signature_hash`, a 64-bit grouping key (masked text is low-entropy, so the hash is a key, not a secret), unless the operator opts in |
| `sayagain.args.shape` | Sorted `key:type` list, never values |
| `sayagain.task_hash`, `sayagain.intent.present` | A 64-bit hash of the task id (it may be free text) and whether intent was supplied |
| `sayagain.session`, `sayagain.server` | The host session the call came from (a stable id, never a one-shot request's) and the registry name of the boundary |
| `sayagain.attempt`, `sayagain.attempts` | Which attempt this span is; later attempts, holds and repairs are children of the first attempt's span |
| `sayagain.repair.kind`, `sayagain.repair.rule` | When arguments were changed |
| `sayagain.turns_to_recover`, `sayagain.recovery_path` | Filled in retroactively when the same tool next succeeds in the task |
| `sayagain.cost.recovery_usd` | Tokens spent between failure and recovery, priced |

Span events mark hold, approval, rejection, replay and dead-letter.
Latency is the span duration. Context size at the time of the call is
recorded when the host supplies it (Claude Code transcripts do; the wire
does not), so recovery cost can be priced.

### Collation: signatures, not messages

Errors are grouped by `(server, tool, error signature)`. The signature is
the first non-empty line of the error with URLs, paths, quoted strings,
identifiers and numbers replaced by placeholders. It is stable across
occurrences and safe enough to show an operator, and it is what the
Databricks table was really keyed on ("KeyError: 'fields'").

For each group the ledger keeps: count, first and last seen, error class,
median turns to recover, share unrecovered, recovery cost, the most common
**recovery path** (the sequence of tools called between the failure and the
next success), and the most common **shape change** (which argument keys
or types differed between the failing call and the successful one).
Recovery paths surface cross-tool dependencies nobody documented; shape
changes surface the contract the model actually needed.

### Ranking: which tools are prone to being mis-called

A tool is ranked by **waste per 1,000 calls**: the summed recovery cost of
its failures divided by its calls. That is the number a budget owner acts
on, and it is what the Databricks table sorted by. Beside it:

- **mis-call rate**: failures classed `coercible` or `semantic` over calls,
  the share of failures that are the contract's fault rather than the
  environment's;
- **identical-retry rate**: retries with unchanged arguments, the share
  that could never have worked;
- **median turns to recover**: the error-message quality proxy;
- **unrecovered share**: failures with no later success in the task.

Reports need a minimum of ten calls per tool before ranking it. The same
ranking is produced from Claude Code transcripts today by
`scripts/baseline/claude-code-baseline.mjs`, from wire-tap logs, and from
the ledger once the proxy runs.

### The loop: interventions that are measured, per context

Patterns become interventions the boundary applies in this user's
deployment. Each intervention is an experiment against the metrics in
`docs/measurement.md`: applied to one tool, compared before and after on
failure rate and turns to recover, and rolled back automatically if the
number does not move. In order of cost:

1. **Learned coercion.** When a signature's most common shape change is a
   type conversion (array to comma-separated string, string to integer,
   ISO date normalisation), the boundary applies it deterministically for
   that tool and records `sayagain.repair.rule = learned:<rule>` (the
   intervention's id stays in the local store, where `sayagain learn`
   shows it with its numbers).
   This is the Databricks fix, applied at the boundary without touching the
   server. Amended 2026-09-05 (ADR-0009, scope guard): a learned coercion
   advises by default (the fact in the description, the repair after a
   failure) and changes a read-only call before it leaves only once an
   operator switches that intervention to `apply`.
2. **Description augmentation.** The boundary appends learned facts to the
   tool description it serves the client: "`fields` is a comma-separated
   string, not an array", "call `get_repo` first; `create_issue` fails with
   not-found otherwise". Only facts backed by a recovery path or shape
   change seen at least three times. The upstream description is never
   modified, only appended to, and the appended block is delimited and
   attributed.
3. **Error rewriting.** For a known signature, the error returned to the
   model carries the fix that worked last time, in one sentence. Turns to
   recover is the metric.
4. **Instruction hints.** Per-server facts that apply to many tools go in
   the one sentence the boundary already appends to `instructions`
   (ADR-0006), capped at three facts.
5. **Pruning suggestions.** Tools called ten or more times with no success,
   and servers whose tools were never called, are reported with the schema
   tokens they cost per turn. Removing them is the operator's action;
   hiding them from `tools/list` is an opt-in policy.
6. **Upstream report.** Signatures with a recovery path or shape change and
   at least ten occurrences are exported as a "tool definition report" in
   the format of the issue template, ready to file against the server.
   This is how the loop leaves the user's context and improves the tool for
   everyone.

Interventions 1 to 4 are per deployment and derived from the local ledger.
Nothing learned from argument values leaves the machine; the cross-tenant
telemetry (ADR-0005) carries only classes, rules and outcomes, which is
enough to say "this tool fails on `fields` for most people".

### Surfaces

- `sayagain tools` — the ranking above, with `--since`, `--server`,
  `--min-calls`, `--json` (0.6; waste is recovery traffic in bytes until a
  host supplies token counts).
- `sayagain errors [tool]` — signatures with counts, class, turns,
  recovery path and shape change (0.6).
- `sayagain learn` — the current learned coercions, augmentations and
  hints, each with its before and after numbers and a `--revert` (0.8:
  interventions 1, 2, 3 and 6 of the loop; 4 and 5 later).
- `sayagain report --weekly` — the one page from `docs/measurement.md`
  section 6, plus the top five signatures (0.6; the annualised cost waits
  for token counts from a host).
- OTLP export, on by default to a local collector if one is listening,
  otherwise off (0.6: `--otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT`, port 4318
  probe; signatures exported as hashes unless the exporter is built with
  `signatures: true`, an API-only opt-in for now).
- The hosted console shows the same objects across a team's deployments
  (hosted tier, after 0.6 telemetry has traffic behind it).

## Alternatives considered

- **Dashboards first.** A Grafana board over OTel spans answers "which tool
  errors recur most" but nobody looks at it daily, and it does not change
  the next call. The loop is the product; the dashboard is the export.
- **Ask a model to summarise failures.** Useful for the weekly narrative,
  useless as the grouping key. Signatures are deterministic and free.
- **Global learning across tenants from argument values.** Faster, and
  incompatible with the trust-domain positioning. Rejected by ADR-0005.

## Consequences

- The ledger schema gains signature, shape, recovery path and turns fields
  and a retroactive update when a task's later call succeeds. Ledger writes
  become two-phase: insert at call time, enrich at recovery time.
- Learned interventions need a kill switch and a per-tool audit trail;
  `sayagain learn --revert` and the ledger's repair record provide both.
- Description augmentation adds schema tokens per turn. Cap at 200
  characters per tool and measure it as waste if the failure rate does not
  fall.
- The transcript analyzer gains the same report so the loop can be
  demonstrated before the proxy exists.
