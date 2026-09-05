# SEP draft: intent, idempotency and compensation for MCP tool calls

- Status: Draft, not yet submitted
- Type: Standards Track
- Author: Kaixiang Ren (happyren)
- Created: 2026-09-05
- Reference implementation: `@sayagain/proxy`, `@sayagain/sdk`, `@sayagain/lint`; the convention in `spec/intent-metadata.md` (v0.1.7)

## Abstract

Three small conventions for the Model Context Protocol, all of them
optional and all of them carried in fields the protocol already has:

1. A client MAY state, in the `_meta` of a `tools/call` request, what it
   means the call to achieve (`intent`) and what it expects back
   (`expect`), plus a client-chosen idempotency key.
2. A server MAY declare, in a tool definition's `_meta`, which argument
   identifies the logical operation (`idempotency`) and which call undoes
   the tool's effect (`compensation`), or that none can.
3. A proxy between them MAY report, in the `_meta` of the result, what it
   did to the call (a receipt, a status, a held-call record, a repair).

Together they let an intermediary, a host, or the server itself tell an
intended call from an accidental one, refuse to execute the same operation
twice, and unwind a sequence that failed partway, without anyone editing
the model's plan.

## Motivation

Tool calls fail in production at a few percent, and a share of those
failures execute side effects nobody acknowledged: a write times out and
the caller does not know whether the world changed, or the model retries a
non-idempotent call with the same arguments. Measured on one developer's
Claude Code history over five weeks (docs/measurement.md): an MCP failure
rate of 4.8%, 73% of failures retried, and 1.4 non-read-only calls per
thousand ending without a known outcome. Across a seeded sample of 400
public registry servers (docs/registry-scan.md), half of the tools listed
carry no documented parameter constraints and a third declare no
annotations, so the protocol's existing `readOnlyHint`, `destructiveHint`
and `idempotentHint` cannot carry the load on their own.

What is missing is not a new transport but three facts that the parties
already know and do not state: why the call is being made, what makes two
calls the same, and how to take one back. `_meta` exists for exactly this
kind of extension, with reverse-DNS keys so conventions can coexist.

## Specification

The normative text is `spec/intent-metadata.md`. In summary, with the
`sh.sayagain/` prefix standing in for whatever namespace a SEP would
settle on:

### Request metadata (client to server, `tools/call` `params._meta`)

| Key | Type | Meaning |
| --- | ---- | ------- |
| `intent` | string | What the call is for, in the client's words. Never interpreted by the server; carried to logs, holds and receipts. |
| `expect` | string or object | What the client expects back, as a description or a probe (`{ "path": "...", "equals": ... }`). |
| `task` | string | A client-chosen task id grouping the calls of one job. |
| `idempotency-key` | string | Unique per logical operation. A receiver that has executed a call with the same key and tool MUST NOT execute it again and SHOULD return the first result. |
| `policy` | object | A per-call tightening (`hold: "always"`); a receiver ignores loosening. |

### Tool declarations (server to client, tool definition `_meta`)

| Key | Type | Meaning |
| --- | ---- | ------- |
| `idempotency` | object | `{ "key": "<argument>" }`: the argument whose value identifies the operation. |
| `compensation` | object | `{ "tool": "<name>", "arguments": { ... } }` with `$arguments.<name>` and `$result.<path>` templates, the call that undoes this one; or `{ "none": "<why>" }`. |

### Result metadata (server or intermediary to client, `result._meta`)

| Key | Type | Meaning |
| --- | ---- | ------- |
| `receipt` | string | An id for the call, stable across a retry and a replay. |
| `status` | string | One of `executed`, `repaired`, `held`, `queued`, `deduplicated`, `dead-lettered`. |
| `held` | object | Why a call waited and what was decided. |
| `repair` | object | What changed in the arguments before the call succeeded, as paths and rules, never values. |
| `duplicate-of`, `replay-of` | string | The receipt this response repeats or replays. |

A receiver that does not understand a key ignores it, as MCP already
requires for unknown `_meta` keys.

## Rationale

- **`_meta`, not new fields.** The protocol reserves `_meta` for this. No
  message changes shape; a client and a server that ignore the convention
  interoperate unchanged.
- **Intent is opaque.** No party interprets `intent`; it is evidence. A
  proxy compares it to what the call did after the fact and reports drift.
  That keeps the convention out of the planner's seat: it returns
  verdicts, it does not act.
- **Idempotency is two-sided.** The client's key covers operations the
  server cannot recognise; the server's declaration covers clients that
  send no key. A receiver honours whichever it has.
- **Compensation is declared, not inferred.** The server knows what undoes
  a call; nobody else should guess. `{ "none": ... }` is a declaration too,
  and the honest one for an email.
- **Informational linting.** A definition without a compensation key is not
  wrong; it is unfinished. The linter says so at info level so scores do
  not punish servers before the convention exists.

## Backward compatibility

Fully compatible. Every key is optional and lives in `_meta`. Existing
servers, clients and hosts see no change. A host that strips unknown
`_meta` keys loses the convention's benefit and nothing else; a schema
shim (spec section 7) exists for hosts that cannot forward `_meta`.

## Security implications

- `intent` and `expect` are client text and MUST be treated as untrusted by
  anyone who reads them; they are never executed or interpreted.
- A compensation declaration names a tool on the same server. A receiver
  MUST NOT run a compensation on another server, and MUST NOT run one for
  a single call on its own initiative.
- Result metadata may reveal that an intermediary exists. A boundary
  announces itself on `initialize` (spec 5.5) so this is not a surprise.
- Idempotency keys are client-chosen; a receiver bounds its retention and
  scopes keys per session or per client to keep one client from replaying
  another's result.

## Reference implementation

- `@sayagain/proxy` emits every result key and honours the request keys
  (spec conformance Level 1).
- `@sayagain/sdk` builds request metadata and the schema shim.
- `@sayagain/lint` checks tool definitions, including
  `annotations/compensation`.
- The registry scan (`sayagain lint --registry`) and the Tool Reliability
  Index (`sayagain index build`) give the numbers above and track adoption
  of the declarations across the public registry.

## Open questions

- The namespace: `sh.sayagain/` today; a SEP would move the keys under
  the protocol's own prefix or a neutral one.
- Whether `compensation` belongs in `annotations` (typed, protocol-owned)
  rather than `_meta` once the shape is stable.
- Whether `status` values need to be an open set for other intermediaries.
