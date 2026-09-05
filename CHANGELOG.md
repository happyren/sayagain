# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-09-05

### Added

- `sayagain hosts`: the MCP hosts configured on this machine (Claude Code,
  Cursor, Claude Desktop, VS Code), their config files, how many servers
  each holds and how many already go through Say Again.
- `sayagain import --host <id>|all [--rewrite]`: registers every server a
  host knows about and, with `--rewrite`, points the host's entries at Say
  Again under the same keys, so the agent still sees "notion". A timestamped
  backup is written beside the file; writes are atomic; other keys,
  indentation and VS Code `inputs` are preserved (comments are not, and the
  tool says so). Entries that already go through Say Again, legacy SSE
  entries, and VS Code entries that use `${input:...}` are skipped with a
  reason. `--dry-run` shows the plan; `--project` includes the project-scope
  files in the current directory; `--transport http` writes daemon URLs
  with the bearer token instead of the stdio shim.
- `sayagain install --host <id>|all [name...]`: writes entries for
  registered servers into a host file.
- `sayagain eject --host <id>|all [name...]`: restores the original entries
  `import` replaced and unregisters the servers it imported; servers added
  by hand stay.
- GUI hosts (Cursor, Claude Desktop, VS Code) do not inherit a shell PATH,
  so their entries use the absolute Node.js and CLI paths; terminal hosts
  get `sayagain` when it is on PATH. `--command <path>` overrides both.
- The `sayagain` package (`npx sayagain`) and per-package READMEs.

### Changed

- Imported `env` and `headers` values are copied into `config.json` (0600)
  as they are. ADR-0006 said copying literal secrets would be opt-in; the
  values already sit in the host's own file, and without them the upstream
  cannot start. Use `${VAR}` references in the registry to move them into
  the daemon's environment.

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
