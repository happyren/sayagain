# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  mode of every coercion.
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
