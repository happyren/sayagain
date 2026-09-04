# ADR-0003: How intent travels

- Status: Accepted
- Date: 2026-09-04

## Context

The proxy sees only the MCP wire: `tools/call` with a name, arguments and
`_meta`. It never sees the model's reasoning, which is where intent lives.
Standard hosts (Claude Code, Cursor, desktop clients, framework adapters)
build the request from the model's tool-use block and will not populate
`_meta` with per-call intent absent a protocol change. Layer 1 therefore
has no data unless something puts it on the wire.

A second problem: a model manipulated into issuing a harmful call will state
a matching intent. Per-call intent cannot be the anchor for detecting that.

## Decision

Three channels, in precedence order:

1. **Native `_meta`.** Clients and SDKs that adopt `spec/intent-metadata.md`
   send `sh.sayagain/intent`, `expect`, `task` and `idempotency-key`
   directly. `@sayagain/sdk` does this for agents built on it.
2. **Schema shim.** For every other host, the proxy rewrites the
   `tools/list` it serves to add optional `intent` and `expect` string
   properties to non-read-only tools, strips them from `arguments` on the
   way in, and moves them to `_meta`. The server never sees them. Cost is
   roughly 15 tokens per tool in the schema and 20 per call.
3. **Task-level intent, out of band.** The host or orchestrator sends the
   task's intent through a transport header (`Sayagain-Task-Intent`), not
   through the model. Drift detection compares each call against this
   anchor. Without it, drift detection is off and the ledger says so.

The earlier position that schema injection "pollutes every tool contract"
was about the server's contract. The shim changes only what the client
sees and is restricted to tools that can write.

## Alternatives considered

- **Proxy the model API instead** (sit between agent and LLM to read the
  reasoning). Full visibility, but it is the LLM-gateway market, which is
  crowded, and it ties the product to model vendors' request formats.
- **A separate `state_intent` tool** the model calls before each write. Adds
  a round-trip per action and models skip it under pressure.
- **Infer intent from the call alone** with a side model. No new
  information; it restates the arguments and cannot detect drift.

## Consequences

- The first experiment is the shim fill-rate: across Claude, GPT, Gemini and
  two open-weight models, how often is the `intent` property filled with
  something usable? Below roughly 60 percent, Layer 1 depends on the SDK
  path and adoption slows.
- Drift detection is a Layer 1 feature that requires host cooperation.
  Marketing must not imply it works zero-touch.
