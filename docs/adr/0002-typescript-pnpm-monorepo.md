# ADR-0002: TypeScript, pnpm workspaces, single repository

- Status: Accepted
- Date: 2026-09-04

## Context

One maintainer. The official MCP SDK is most mature in TypeScript, most MCP
servers are TypeScript, and the linter must run where server authors work
(`npx`, GitHub Actions). The proxy needs HTTP and stdio transports, JSON-RPC
handling, a Postgres-backed queue and ledger, and an occasional side-model
call. Nothing in that list needs native performance.

## Decision

- TypeScript on Node 22+, strict mode, ESM only.
- pnpm workspaces with three packages: `proxy`, `lint`, `sdk`. Biome for
  lint and format, Vitest for tests, `tsc` for type checking.
- Ship the proxy as an npm binary and a container image. Ship the linter as
  an npm binary and a GitHub Action.

## Alternatives considered

- **Go.** Best single-binary self-host story and lowest latency. Loses on
  speed of iteration for one person and on distance from the server-author
  audience. Revisit for the hot path if the proxy's own overhead exceeds
  5 ms p99 on local transport.
- **Python.** Matches two plugin targets (ContextForge, LiteLLM). Loses on
  packaging for the linter and on transport performance. Plugin adapters for
  those hosts can be thin Python shims that call the proxy over HTTP.
- **Separate repositories per package.** More ceremony than one maintainer
  can carry; the spec and the packages change together at this stage.

## Consequences

- Python and Rust gateway plugins are adapters, not ports. Keep the proxy's
  HTTP surface stable enough to sit behind one.
- Revisit the language decision when latency measurements exist, not
  before.
