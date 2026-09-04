# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
