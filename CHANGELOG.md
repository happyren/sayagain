# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Ledger rows carry `errorClass`, `attempts`, `repairs` and `replayOf`.

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
