# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.17.0] - 2026-09-06

### Added

- Verification before resumption (ADR-0013, spec v0.1.8 section 8.3). A tool
  may declare `sh.sayagain/verify` in its `tools/list` `_meta`: the read-only
  tool that says whether its effect is present, an argument template over the
  original call, and whether success or a not-found failure proves it (a
  deletion reads as an absence). After a write ends with an unknown outcome,
  the boundary runs the verifier before deciding: present, and the call is
  answered as executed with `sh.sayagain/verified` on the result; absent, and
  one re-send goes out without a hold, since the world said nothing landed;
  inconclusive, and the call is held as before. A verifier that is not
  read-only is ignored. The read-back is one of the boundary's own calls with
  its own ledger row, marked `verifies` with the receipt it checked. On by
  default, off with `verify: false` in the policy.
- `@sayagain/lint` rule `annotations/verify` (informational): a tool that is
  neither read-only nor idempotent declares how to read its effect back. Rule
  set 2026-09-06.1; grades do not move.
- The harness gained `--verify on|off` and `--placebo`. The placebo runs the
  treatment arm with the boundary in its control mode, so any difference
  outside the byte rows is the instrument measuring itself. Over 300 paired
  tasks the placebo shows zero on every such row.

### Result

300 paired tasks over the pre-registered seeds. A write loses its answer
once and a second attempt answers; the first cut lost every attempt, which is
an outage rather than a lost answer, and inflated the duplicate counts of any
arm that retries. Every outcome is printed; a positive difference means the
control arm had more of it, and the last three rows are what the boundary
costs.

Approving operator, read-back off against on:

| per task | control | off | on |
|---|---|---|---|
| writes that happened, unknown to all | 0.02 | 0.02 | 0.00 |
| writes the agent could not resolve | 0.00 | 0.00 | 0.00 |
| writes believed that never happened | 0.00 | 0.00 | 0.00 |
| records left in the wrong state | 0.00 | 0.00 | 0.00 |
| non-idempotent writes run twice | 0.03 | 0.03 | 0.00 |
| any write run twice | 0.05 | 0.05 | 0.02 |
| calls the server actually ran | 5.30 | 5.34 | 5.37 |
| calls the agent spent recovering | 1.60 | 0.54 | 0.48 |
| bytes the agent spent recovering | 180 | 178 | 148 |
| failures the agent saw | 0.82 | 0.28 | 0.24 |
| calls the agent made | 5.30 | 4.78 | 4.74 |
| bytes delivered to the agent | 542 | 1040 | 1016 |

Without the read-back the boundary matches the control arm on every harm
count and halves what the agent has to handle. With it, the duplicates the
agent's own retries cause fall to zero and the silent unknowns to zero, both
distinguishable, and the bytes spent recovering fall as well. The server runs
the verifiers (5.37 calls against 5.30) and the receipts double the bytes
delivered; both stay printed.

With a rejecting operator the harm counts are the same as with read-back on,
and records are left in the wrong state 0.26 times per task against zero in
control: a destructive call declined before it is sent has no outcome to read
back, and an operator who declines every delete gets no deletes.

The placebo, the boundary in its control mode over the same 300 tasks, shows
exactly zero on every row but the two byte rows.

### Note

The first cut of this instrument reported that the boundary halved
unacknowledged writes and removed double execution. Those results were
artifacts of four defects found in review before release: the stand-in
operator was never wired to the event the boundary emits, a held response was
scored as a successful write, work the treatment arm declined was never
counted, and the metric named for M9 measured a different quantity from the
one M9 defines. A second review then found the read-back re-sending on any
"semantic" failure of the verifier rather than only on an absence, honouring
a template it could not resolve as a literal, and never reaching a destructive
call at all; all three are fixed and tested, and the fault model's permanent
loss, which produced the "approving doubles execution" figure, is corrected
above.

## [0.16.0] - 2026-09-06

### Added

- The fault-injection harness (`scripts/experiment/`, pre-registered as
  docs/measurement.md 5.6). Each task is its own cluster, and the same task is
  run twice against the same seeded faults, once through the boundary and once
  past it, so 300 paired observations take under a minute where the organic
  A/B needs a session apiece. The upstream is a real stdio MCP server that
  fails on a seed, logs every call it actually ran, and writes down every side
  effect that really happened, so what the agent believes can be checked
  against what the world did. Faults are drawn on the logical step, so a repair
  or a retry by either side meets the same fault.
- Twelve outcomes, reported in both directions, including the ones that count
  against the boundary: work left undone, writes believed that never happened,
  duplicate execution, and the calls the server actually ran.

### Result

300 paired tasks over the pre-registered seeds. **Neither operator rule is a
clean win, and that is the finding.**

With an approving operator, the boundary moves work off the agent and adds it
elsewhere:

| outcome, per task | control | treatment | difference | 95% interval |
|---|---|---|---|---|
| failures the agent saw | 0.92 | 0.44 | 0.48 | 0.41 to 0.55 |
| calls the agent spent recovering | 1.65 | 0.71 | 0.94 | 0.80 to 1.08 |
| non-idempotent writes run twice | 0.06 | 0.15 | -0.09 | -0.15 to -0.04 |
| calls the server actually ran | 5.35 | 5.62 | -0.27 | -0.39 to -0.15 |
| writes that happened, unknown to all | 0.05 | 0.05 | 0.00 | 0 to 0 |
| bytes delivered to the agent | 549 | 1127 | -577 | -621 to -533 |

With a rejecting operator the trade reverses: writes nobody knows about fall
from 0.05 to 0.01 and double execution falls to zero, but records are left in
the wrong state 0.29 times per task against zero in control. H6 asks for a
reduction in cost without breaking the workload; declining held calls breaks
it.

The boundary converts a silent unknown into a decision, and the decision is
lossy either way because it is taken without checking whether the write landed.
Verification before resumption is what the harness points at next.

### Note

The first cut of this instrument reported that the boundary halved
unacknowledged writes and removed double execution. Those results were
artifacts of four defects found in review before release: the stand-in operator
was never wired to the event the boundary emits, a held response was scored as
a successful write, work the treatment arm declined was never counted, and the
metric named for M9 measured a different quantity from the one M9 defines. The
numbers above come from the corrected instrument.

## [0.15.0] - 2026-09-06

### Added

- `sayagain report --ab` reports the clustering the experiment actually has:
  how many sessions the coin was flipped over, how strongly failures correlate
  inside one, and the resulting design effect. Rate intervals are widened by
  it. On this machine's own 30 days the design effect is near ten, and a
  simulated null shows that an interval ignoring it covers at 0.47 against a
  nominal 0.95 and calls the boundary a winner 27% of the time.
- The fill rate, the date the target is met at that rate, and what a sample of
  that size can distinguish. The projection waits for a fortnight of armed
  calls and measures against elapsed time, so a busy afternoon cannot promise
  a date it will not keep.
- The failure tax is also printed as its two factors, the failure rate and the
  bytes a failure costs, which move for different reasons.
- A cluster bootstrap over sessions is printed beside the failure tax's normal
  interval, as a check on whether the clustering changes that answer. The
  normal interval remains the pre-registered primary: simulation puts it at
  0.95 coverage for this outcome's shape, and the recovery-byte series does
  not cluster.

### Changed

- The pre-registered minimum span is 12 weeks, not two. At the rate this
  machine's wrappable servers produce, 2,000 calls per arm takes about 85
  days.
- `docs/measurement.md` 5.4 carries the power analysis and names its
  instrument. Its conclusion is that this experiment can speak to the failure
  tax and cannot speak to M9, the north-star risk metric, on any timescale
  worth waiting for: the calls arrive in too few independent sessions. That is
  recorded now, with the ledger still holding only its commissioning rows.

## [0.14.0] - 2026-09-06

### Added

- `sayagain doctor`: one command that checks the whole setup and prints the
  command that fixes each finding, most serious first (ADR-0012). It names
  servers a host still calls directly, a server configured in one project and
  nowhere else, a stdio server the daemon starts without the working directory
  its host gave it, an environment reference the daemon cannot resolve, tools
  whose class comes from nothing, reads that are held on every call because the
  server annotates them destructive, calls still waiting for a decision, and a
  wrapped host whose calls never arrive. Exits 1 when something is broken.
  `--no-probe` skips starting the upstreams.
- `sayagain classes <name>|--all`: what class each tool gets, where it came
  from (the operator's table, the server's annotations, or the cautious
  fallback) and what the boundary does with it. `--suggest` adds the class the
  tool's name implies where it differs. `--write` stores the suggestions that
  raise a class; one that lowers a class drops a hold, allows a retry and
  allows a pre-send coercion, so it is written only with `--write --lower`.
  A lowering is proposed only when the whole name and the description's first
  sentence read as a read, so `find_and_replace`, `get_lock` and
  `check_out_book` are left alone.

### Changed

- A class table or hold mode written while the daemon runs is applied to the
  boundary in place, with no restart and no dropped upstream: `POST
  /api/policy/reload`, which `classes --write` calls for you.
- `import` records a project-scoped server's project directory as its working
  directory, when that directory still exists. The host started that server
  inside the project; the daemon starts it from its own directory, so a server
  that finds its work by the current directory used to come up empty.
- `sayagain add` keeps the record of where an imported server came from, so
  re-registering one (to add `--cwd`, say) no longer leaves `eject` unable to
  restore the host's original entry. A class table and hold mode survive too
  unless the command sets them.
- `sayagain classes` follows `tools/list` pagination, so a table written from a
  paginated server keeps the tools it did not show.
- `import --rewrite` and `install` end by pointing at `sayagain doctor`.

## [0.13.0] - 2026-09-06

### Added

- The A/B protocol of `docs/measurement.md` 5.4, inside the boundary
  (ADR-0011). `sayagain serve --arm coinflip` assigns each host session to
  a control or a treatment arm (`--arm daily` gives every session of a
  UTC day the same arm and follows the calendar; `--arm control` and
  `--arm treatment` pin one arm; `--arm off` ends the experiment;
  `sayagain wrap --arm` does the same for one process). The control arm
  forwards every call as it came and records it: no hold, dedupe, retry,
  repair, learned coercion, hint, description augmentation, guidance text
  or announcement, and a call the upstream never answers is reported as
  such, not dead-lettered. Control results are not remembered for dedupe
  and the learning loop never reads control rows. Every ledger row
  carries its arm (a hold resumed after a restart keeps it); a host that
  sends no session id keeps one arm for the daemon's lifetime under
  `coinflip`. `sayagain status` and `/api/health` show the mode; it
  persists in `config.json` until `--arm off`.
- `sayagain report --ab` (30-day window by default): both arms side by
  side with the report's definitions and the number of sessions
  (clusters), then the differences, control minus treatment, with 95%
  intervals: unacknowledged writes per 1,000 writes (primary risk,
  Newcombe), recovery bytes per call (the failure tax, primary cost, a
  normal interval on Welch's standard error) and the failure rate
  (secondary); a verdict against the pre-registered minimum of two weeks
  or 2,000 calls per arm, whichever is later; rows outside the experiment
  counted and left out. `--json` for the numbers.

## [0.12.0] - 2026-09-05

### Added

- `sayagain index build`: the Tool Reliability Index as a static site
  (ADR-0010) from a registry scan and the contributed shape documents:
  `index.html` with the headline number and every graded server, a page
  and an SVG badge per server, a badge per tool, and `index.json`. A tool's
  static score is its linter grade (A 100 to F 20), a server's the mean;
  a runtime score, where shapes exist, is 100 minus the failure rate on
  contributed calls with the dominant error class, per-family counts, the
  resolution that worked and a suggestion. Public registry data and
  aggregates only. `sayagain index fixes <server>` prints the maintainer's
  message: the score and the two fixes that move it most.
- The `Index` workflow scans a seeded sample and builds the site on
  demand; publishing to GitHub Pages and the weekly schedule are switched
  on by the repository variables `SAYAGAIN_INDEX_PAGES` and
  `SAYAGAIN_INDEX_SCHEDULE`.
- Spec v0.1.7: section 8, tool declarations. `sh.sayagain/idempotency`
  names the argument that identifies the operation;
  `sh.sayagain/compensation` names the call that undoes the tool's effect,
  or that none can. `@sayagain/lint` reports a tool that is neither
  read-only nor idempotent and declares no compensation
  (`annotations/compensation`, informational: grades and M16 do not move;
  rule set 2026-09-05.1). The SEP draft is `docs/sep-draft.md`; the data
  post draft is `docs/data-post.md`.

## [0.11.0] - 2026-09-05

### Added

- `sayagain lint --registry`: the registry scan of `docs/measurement.md`
  5.5. Lists the public MCP registry, asks every server with a Streamable
  HTTP remote for its tools without credentials, grades them with
  `@sayagain/lint`, and prints the outcome counts (ok, auth,
  refused, unreachable, not-mcp, no-tools, skipped), the grade distribution,
  the share of tools with a finding per rule, and M16 (tools without
  documented parameter constraints) with a 95% interval, the per-server
  view, the coverage statement, and the rule-set version. `--sample <n>
  --seed <n>` for a reproducible random sample of the servers with a
  remote, `--first <n>`, `--concurrency`, `--timeout`, `--out <file>` for
  the per-server results (registry names, URLs, outcomes, findings: public
  registry data), `--json`. The page and `--json` name no server; the
  progress log on stderr does. The first scan is in
  `docs/registry-scan.md`.
- `sayagain audit --project <name>`: one project's sessions only (its
  directory name; worktrees and variants included; Codex sessions by their
  working directory), for the per-agent baselines.
- `@sayagain/lint` implements `params/constrained`: a number without
  bounds, or a string that reads as an id, date or choice without a
  format, pattern or enum, is a warning. `RULE_SET_VERSION` (2026-09-05)
  is exported and quoted by the scan.

## [0.10.0] - 2026-09-05

### Added

- `sayagain audit`: the one page from `docs/measurement.md` section 6 over
  your own Claude Code, Codex and Cursor transcripts (Phase 0 of the
  roadmap). The 0.6 analysis runs over transcript rows: unacknowledged
  writes first, then the failure tax in dollars (tokens priced at list),
  failures by server, duplicates, recovery cost, sessions that ended on a
  failure, what moved against the previous window, and the tools most prone
  to mis-calls with their masked signatures. Writes a static HTML page to
  `~/.sayagain/audit/` (or `--html <file>`) that carries names, counts and
  masked signatures and nothing else. `--source`, `--dir`, `--since`,
  `--min-calls`, `--top`, `--json`, `--no-html`. The `scripts/baseline`
  analyzer stays as the pre-registered instrument.
- `sayagain contribute`: the opt-in shape contribution of ADR-0009. Builds
  the `sayagain.shape/1` document from the ledger or a host's transcripts,
  writes it to `~/.sayagain/contributions/` first, prints it in full, and
  sends it only after a `y` (or `--yes`) to the endpoint you name, once
  `--accept-terms 2026-09-05` has been given. No endpoint exists yet
  (decision 3): without one the command stops after writing. `--status`,
  `--weekly on|off` (the daemon then sends one document a week from the
  ledger; `SAYAGAIN_CONTRIBUTE=0` stops it), `--forget` (deletes on the
  index and rotates the contributor id). `docs/CONTRIBUTING-DATA.md` is the
  terms document. A structural check refuses any document with a field
  outside the schema, a name with a path in it, or a value where a shape
  belongs.
- Transcript readers for Claude Code (`~/.claude/projects`), Codex
  (`~/.codex/sessions`) and Cursor (`~/.cursor/projects/*/agent-transcripts`)
  turn sessions into ledger rows: tool names, argument shapes and hashes,
  masked signatures, tokens and timestamps; argument values, results and
  prompts are dropped in memory.

### Changed

- The analysis knows two error classes only transcript rows carry:
  `interrupt` (the user stopped a running call) and `no-result` (the file
  has no result for it). Both count as unknown outcomes for a write (M9)
  and not as failures (M1). A call the user rejected before it ran gets no
  row: the tool never executed. A call still in flight within an hour of
  the file's last line is not a missing result. A subagent transcript
  belongs to its parent's session. Recovery windows now list their rows.
- Masked error signatures also hide email addresses, hostnames, Windows
  paths and single-slash `owner/repo` names, so the audit page and the
  `errors` listing carry less that identifies a machine.

## [0.9.0] - 2026-09-05

### Changed

- The scope guard from the roadmap adjustment of 2026-09-05 (ADR-0009): the
  boundary returns verdicts and never acts on the plan. A learned coercion
  therefore **advises** by default (the fact in the tool description, the
  hint in the error, the repair after a failure) and changes a read-only
  call before it leaves only once an operator switches that intervention to
  **apply**: `sayagain learn --apply <id>` (`--advise` to go back), the
  `/api/learn/:id/apply` and `/advise` routes, or the Learn screen. Files
  from 0.8.0 carry no mode and load as advise. `sayagain learn` shows the
  mode of every coercion. A `wrap` still running from 0.8.0 reads the same
  file and ignores the mode, so restart wraps after upgrading.
- The north star is reported risk first: unacknowledged writes lead, the
  failure tax follows, in `sayagain report`, on the Report screen, and in
  `docs/measurement.md` (a dated amendment; no metric definition changed).
- `docs/ROADMAP.md` is the six-phase plan from the adjustment. ADR-0009
  records the contributed-shape schema and the consent flow for Phase 0,
  and the audit of 0.1 to 0.8 against the scope guard.

## [0.8.0] - 2026-09-05

### Added

- The learning loop (ADR-0007), from this deployment's own ledger, argument
  values never read. A signature seen at least three times with a recovery
  that changed an argument's type becomes a **learned coercion**: the
  boundary applies the conversion before a read-only or idempotent call
  leaves (`sh.sayagain/repair` rule `learned:<rule>`, status `repaired`; a
  coerced call that still fails is an ordinary failure, not a dead letter),
  and offers it as the repair after a failure on any tool, where a write
  still waits behind a hold. Only a conversion that prints back as the same
  text is applied: `"007"` and `"1e3"` are left alone. Evidence counts the
  specific change, not the signature, and a diff that also added or removed
  a key teaches nothing. A semantic failure whose usual recovery began with
  another tool becomes a **hint**: a sentence appended to the tool's
  description in `tools/list` (delimited `[Say Again learned]`, at most 200
  characters, the upstream's text untouched) and to the error the model sees
  when the signature recurs, naming what fixed it last time.
- Every intervention is measured: the tool's failure rate and median calls
  to recover before and after activation. After twenty calls without a lower
  failure rate, measured on that failure's own signatures, it reverts itself
  and says why. The daemon runs the pass at start and every ten minutes over
  the last ninety days; `wrap` reads `~/.sayagain/learned.json` when it
  exists and picks up changes within seconds, but does not measure or
  revert on its own (`wrap --no-learn` ignores the file).
- `sayagain learn [--update] [--json]` lists interventions with their
  numbers (only `--update` derives and writes); `--disable <id>` and
  `--enable <id>` switch one, keeping the automatic verdict in the record;
  `--report
  <server>` prints a tool definition report (signatures with ten or more
  occurrences, what fixed them, what the loop tried) to file against the
  upstream. Routes `/api/learn`, `/api/learn/update`,
  `/api/learn/:id/disable|enable`, `/api/learn/report/:server`; a Learn
  screen in the page.

### Deferred

- Per-server instruction hints and pruning suggestions from ADR-0007, and
  the settings screen.

## [0.7.0] - 2026-09-05

### Added

- `sayagain ui`: the operator page, served by the daemon at `/ui` (ADR-0008).
  A live holds inbox with approve and reject (orphaned holds marked),
  servers and daemon health, dead letters with replay and optional edited
  arguments, a filterable ledger tail, and the 0.6 analysis as tables:
  tools, errors, report, over a selectable window. Holds, dead letters and
  the ledger refresh live from `/api/events`. No framework, no bundler,
  nothing loaded from a remote origin; a strict Content Security Policy;
  the token is carried on the query string once, moved into the tab's
  session storage, and sent as a header from then on. The page and its
  assets are public (a reload has no token in its URL); every API call
  needs the header, and the query token is accepted for event streams only.
- The package `build` script now emits the browser module too; `pnpm test`
  builds it first.
- `/api/tools`, `/api/errors`, `/api/report` with `since`, `server` and
  `minCalls`, so the page never computes over the ledger itself.

## [0.6.0] - 2026-09-05

### Added

- `sayagain tools`: tools ranked by the waste their failures cause per
  thousand calls (recovery traffic in bytes, the wire's stand-in for
  tokens), with failure and mis-call rates, identical-retry share, median
  calls to recover, unrecovered share, latency, and what the boundary did
  (retried, repaired, held, dead-lettered, deduplicated). `--since 7d`
  (or `--weekly`), `--server` (registry name or the upstream's own name),
  `--min-calls`, `--ledger <path>`, `--json`; latency and first/last seen
  in the text output too.
- `sayagain errors [tool]`: failures grouped by masked signature with count,
  class, first and last seen, median calls to recover, the most common
  recovery path and argument-shape change, and a suggestion (ADR-0007).
- `sayagain report`: the weekly page from `docs/measurement.md` section 6,
  from the ledger alone: the north-star pair (failure tax per 1K calls,
  unacknowledged writes per 1K writes), M1 and M7 by server, M8 duplicates
  and M9 with the tools involved, M5 and M17 recovery, M15 boundary
  outcomes, the top signatures, and what moved against the previous window.
- OTLP export: one span per call over OTLP/HTTP JSON with GenAI and
  `sayagain.*` attributes and hold, dead-letter and replay events.
  `serve --otlp <url>` and `wrap --otlp <url>`; otherwise
  `OTEL_EXPORTER_OTLP_ENDPOINT` (and `_HEADERS`), otherwise a local
  collector on port 4318 when one answers; `--otlp off` disables it and
  `SAYAGAIN_OTLP=off` disables it machine-wide. `serve --otlp` is remembered
  in `config.json`, so a daemon the shim restarts keeps exporting; `wrap`
  flushes its last spans before exiting. Error
  signatures and task ids leave as 64-bit hashes (grouping keys, not
  secrets) unless the exporter is built with `signatures: true`; argument
  values never leave. A local collector is adopted only when it answers an
  empty traces request, not merely because something owns the port.
- `sayagain lint <name>|--all|--file tools.json [--fail-below <grade>]`:
  grades tool definitions with `@sayagain/lint` through the daemon's
  `tools/list` (starting the upstream if needed); exits 1 when a server
  could not be read or a tool grades below the threshold.
- Ledger rows carry the host `session` the call came from (one-shot HTTP
  requests without a session id are pooled by task, then by upstream), which
  is what orders calls for recovery analysis, and the registry `server`
  name beside the upstream's own. `/api/ledger?since=<iso>[&tail=n]`
  returns rows from a time.

### Deferred from the roadmap row

- The GitHub Action for `@sayagain/lint`, the public registry scan (M16),
  and the transcript analyzer reading wire-tap logs.

## [0.5.1] - 2026-09-05

### Removed

- The bare `sayagain` wrapper package. npm rejects the name as too similar
  to the existing `say-again` (names that differ only by punctuation are
  blocked), which also means nobody else can take it. Install
  `@sayagain/proxy`; it provides the `sayagain` command.

## [0.5.0] - 2026-09-05

### Added

- `sayagain hosts`: the MCP hosts configured on this machine (Claude Code
  with its user, local and project scopes, Cursor, Claude Desktop, VS
  Code), their config files, how many servers each holds and how many
  already go through Say Again.
- `sayagain import --host <id>|all [--rewrite]`: registers every server a
  host knows about and, with `--rewrite`, points the host's entries at Say
  Again under the same keys, so the agent still sees "notion". The entries
  point at `~/.sayagain/bin/sayagain`, a launcher that every onboarding
  command and every daemon start rewrites with the current Node.js and
  package paths, so host files never change when either moves. A backup
  goes to `~/.sayagain/backups` (never overwritten); the write is atomic,
  keeps the file's mode and indentation, follows symlinks, and leaves every
  other key, non-object entry and VS Code `inputs` alone (comments are not
  kept, and the tool says so). Entries that already go through Say Again,
  legacy SSE entries, and entries with host variables the boundary cannot
  resolve (`${input:...}`, `${workspaceFolder}`, `${VAR:-default}`) are
  skipped with a reason; `${env:X}` becomes `${X}`. After a rewrite the
  daemon is started from the current shell so it inherits the PATH and
  exported tokens the upstreams expect (`--no-start` skips that). `--dry-run`
  shows the plan and touches nothing; `--project` includes the project files
  in the current directory; `--transport http` writes daemon URLs with the
  bearer token for hosts that accept them; `--command` overrides the launcher.
- `sayagain install --host <id>|all [name...]`: writes entries for
  registered servers into a host file.
- `sayagain eject --host <id>|all [name...]`: restores the original entries
  `import` or `install` replaced (unless edited by hand since), unregisters
  the servers `import` registered once no host uses them (`--keep` keeps
  them), removes entries whose server was installed from the registry, and
  leaves any other Say Again entry in place unless `--prune`.
- `sayagain remove` warns when the server was imported, since `eject` is
  the way to put the host entry back.
- A daemon started by a GUI host's shim gets this Node.js on its PATH.
- Claude Code's user file honours `CLAUDE_CONFIG_DIR`; while a Claude Code
  session runs, onboarding warns that the session may rewrite the file.
- The `sayagain` package (`npx sayagain`) and per-package READMEs.

### Changed

- Imported `env` and `headers` values are copied into `config.json` (0600)
  as they are. ADR-0006 said copying literal secrets would be opt-in; the
  values already sit in the host's own file, and without them the upstream
  cannot start. Use `${VAR}` references in the registry to move them into
  the daemon's environment.
- `import` and `install` exit 1 when any host file could not be processed.

## [0.4.0] - 2026-09-05

### Added

- `sayagain serve`: one daemon on loopback with a bearer token, one virtual
  server per registered upstream at `/mcp/<name>` (Streamable HTTP POST,
  plus a GET event stream for server notifications), and a control API
  (`/api/health`, `servers`, `holds`, `deadletters`, `replay`, `ledger`,
  `events`, `shutdown`). `--detach` runs it in the background.
- `sayagain add <name> -- <command>` and `--url <url>` register upstreams in
  `~/.sayagain/config.json`; `remove`, `list`, `status`, `stop`.
- `sayagain stdio <name>`: a thin stdio client for hosts that only spawn
  commands; starts the daemon if none is running; fails closed.
- Streamable HTTP upstreams (`HttpUpstream`), with `Mcp-Method` and
  `Mcp-Name` hints on every POST.
- Persisted holds: a held call survives a daemon restart (JSONL by default,
  `holds.jsonl`). Reloaded holds are listed as orphaned, since the host that
  sent them is no longer waiting; approving one executes it and records the
  result in the ledger.
- SQLite storage (`serve --store sqlite`, `node:sqlite`, Node 22.13+):
  ledger, dead letters and holds in one file. JSONL remains the default, and
  the fallback on a Node.js without `node:sqlite`.
- The boundary core (`Boundary`) now multiplexes any number of hosts over
  one upstream, with request ids remapped per host and server-to-client
  requests routed to the single attached host; `wrap` is a thin shell
  around it.
- `SAYAGAIN_HOME` relocates every file the tool keeps. The home directory,
  `config.json`, `token`, `daemon.json` and the data files are created 0600
  or 0700: they hold tokens, hold arguments and dead letters.
- The daemon's bearer token lives in `~/.sayagain/token` and is stable
  across restarts, so a host entry pasted once keeps working.
- Hosts get an `Mcp-Session-Id` on `initialize`; requests that carry it
  share one session, so `notifications/cancelled` and server-to-client
  requests reach the right host.
- `scripts/bench/overhead.mjs` measures M15e. On this machine, 500
  sequential `echo` calls: direct stdio p99 0.38 ms, `wrap` p99 0.54 ms,
  daemon over HTTP p99 2.04 ms. The 0.4 gate (p99 overhead under 25 ms) is
  met.

### Changed

- The registry is JSON (`config.json`) rather than the TOML named in
  ADR-0006; a TOML parser is not worth a dependency yet.
- Client request ids are no longer forwarded verbatim to the upstream; they
  are remapped so several hosts can share it. Arguments are untouched.
- `wrap --ledger <path>` keeps its meaning (a JSONL file); the daemon takes
  `--store jsonl|sqlite` and `--db <path>` instead, so the same flag does
  not mean two things.

## [0.3.0] - 2026-09-05

### Added

- Bounded retry with exponential backoff for retryable failures on
  read-only and idempotent tools (`--retry <n>`, default 3 attempts).
- Hold-on-unknown-outcome: a write or destructive call that fails with a
  retryable error is held instead of retried; approve re-sends it once.
- Deterministic argument repair from the tool's own `inputSchema` on
  coercible failures: type coercion, key rename by normalised name,
  defaults for missing required properties. One repair per call, three per
  task; recorded in `sh.sayagain/repair` and, paths only, in the ledger.
- Dead-letter: a failure after a retry or repair is `dead-lettered`, kept
  with its intent in `~/.sayagain/deadletter.jsonl`, listed by
  `sayagain deadletters`, and re-sent by `sayagain replay <receipt>
  [--args]` through the running boundary; the result carries
  `sh.sayagain/replay-of`.
- Error rewriting: one actionable sentence appended to every failed
  result, per error class, naming the receipt (`--no-rewrite-errors`).
- Ledger rows carry `errorClass`, `attempts`, `repairs`, `replayOf` and
  `budget`.

### Fixed (review before merge)

- Client lines are processed in order; a cancelled held call is dropped and
  never executed; `--hold never` also disables the unknown-outcome hold.
- A write that fails with an unknown outcome is answered as such (not "has
  not been executed"), and the failed attempt is in the ledger.
- Repaired arguments of a write or destructive call wait for approval
  before they are sent; repair budgets fall back to a ten-minute window
  when no task id is supplied, marked in the ledger.
- Concurrent identical writes wait for the first result and are answered
  DISREGARD; the fingerprint is used only without an idempotency key and
  includes the task; argument hashing is key-order independent; a repaired
  call is remembered under the arguments the client sent.
- JSON-RPC error responses carry the receipt in `error.data`; `repaired`
  status is emitted; the proxy no longer crashes on an error without a
  message, on spawn failure, on writes after the client closed, or on a
  control-socket disconnect; multi-byte characters split across chunks are
  decoded correctly; numeric CLI options are validated.
- Dead letters survive restarts and are resolved after a successful
  replay; replays time out; `sayagain deadletters --deadletter <path>`.
- Version is read from `package.json`; release notes extraction fixed; test
  files are type-checked.

## [0.2.0] - 2026-09-05

### Added

- Tool classification from `tools/list` annotations and `--class tool=class`
  overrides; unknown tools are `write`. Every ledger row carries the class.
- DISREGARD: a repeated `sh.sayagain/idempotency-key`, or a repeated write
  with the same arguments inside `--dedupe-window`, is answered from the
  first result with status `deduplicated` and `sh.sayagain/duplicate-of`.
- STANDBY: destructive tools are held before leaving (`--hold
  destructive|always|never`). The call waits up to `--hold-wait` for a
  decision; approve forwards it once, reject answers UNABLE, no decision
  answers a held notice and keeps the hold open for an hour.
- `sayagain holds`, `sayagain approve <receipt>`, `sayagain reject
  <receipt>` over a per-process control socket in `~/.sayagain/run`.

## [0.1.0] - 2026-09-05

### Added

- `sayagain wrap -- <server command>`: a stdio passthrough that leaves the
  server's identity untouched, issues `sh.sayagain/receipt` and
  `sh.sayagain/status` on every `tools/call` result, announces the boundary
  on `initialize`, and records every call in a JSONL ledger.
- `sayagain ledger [--tail N] [--json]` to read that ledger.
- Release tooling: `scripts/release.mjs`, the `Release` workflow, and
  `docs/RELEASING.md`; the roadmap in `docs/ROADMAP.md`.

- Repository scaffold: license, DCO, governance, security policy, CI.
- `spec/intent-metadata.md` draft v0.1.
- ADRs 0001 to 0005.
- Package skeletons for `@sayagain/proxy`, `@sayagain/lint`, `@sayagain/sdk`.
