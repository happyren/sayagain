# ADR-0004: Non-idempotent calls are held, never blindly re-executed

- Status: Accepted
- Date: 2026-09-04

## Context

MCP's `idempotentHint` is advisory and untrusted. Most MCP servers wrap
REST APIs that do not accept idempotency keys, so the proxy cannot make a
downstream call safe to repeat. A replayed write that duplicates a payment,
a message or a deletion ends a reliability product's credibility in one
incident. Simulation work on verified tool calls shows postcondition checks
and idempotency keys cut duplicate side effects sharply, but only when
retry is gated on them.

## Decision

- Tools are classified `read-only`, `idempotent-write`, `write` or
  `destructive` from annotations, a maintained per-server table, and
  operator overrides. Unknown tools are `write`.
- `read-only` calls pass through with retry and no queue.
- `idempotent-write` calls may be retried with bounded backoff.
- `write` and `destructive` calls that fail, time out, or lack a required
  postcondition are **held**, not retried. Replay is an operator action in
  the console, or an explicit policy opt-in per tool, and always shows the
  original intent and arguments.
- The proxy deduplicates on `sh.sayagain/idempotency-key` and, when
  absent, on a fingerprint of tool, arguments and task within a short
  window. This prevents the agent from double-firing; it does not make the
  server idempotent, and documentation must not claim exactly-once.
- Model-driven repair never touches the arguments of a `write` or
  `destructive` call without a hold first.

## Alternatives considered

- **Retry everything with backoff** (Temporal-style). Correct for durable
  workflows with idempotent activities; wrong here because the activities
  are not ours.
- **Refuse all writes without an idempotency key.** Safest, unusable today;
  almost no host sends one.

## Consequences

- Held calls need an approval surface from day one, even if it is a CLI.
- Per-server classification tables are a maintained asset and a
  contribution path.
- Latency for held writes is unbounded by design; target unattended agents
  first.
