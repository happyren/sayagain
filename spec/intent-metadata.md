# Say Again Intent Metadata for MCP Tool Calls

| Field          | Value                                             |
| -------------- | ------------------------------------------------- |
| Status         | Draft v0.1.2                                      |
| Namespace      | `sh.sayagain/`                                  |
| Applies to     | MCP specification 2026-07-28 and later            |
| License        | Apache-2.0 (implementable by anyone, no attribution required in code) |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted
as described in RFC 2119.

## 1. Motivation

An MCP `tools/call` request carries a tool name and arguments. It does not
carry what the caller was trying to achieve, whether the call may safely run
twice, or which task it belongs to. A component sitting between client and
server (a "boundary") therefore cannot decide whether a well-formed call is
the right call, cannot retry safely, and cannot explain a failure to an
operator in the agent's terms.

This document defines a small set of `_meta` keys that let a client state
intent and safety properties, and a set of result keys that let a boundary
report what it did. It uses the reserved `_meta` object and reverse-DNS
prefixing exactly as the MCP specification describes, so it needs no change
to the protocol and is ignored by components that do not understand it.

## 2. Terms

- **Client**: the MCP client issuing `tools/call` (a host application or an
  SDK used by an agent).
- **Boundary**: any component that receives `tools/call` before the server
  and may queue, hold, repair, forward, dead-letter or replay it. Say Again
  is one boundary; a gateway plugin is another.
- **Server**: the MCP server that executes the tool.
- **Task**: a unit of agent work spanning many calls, identified by an opaque
  string.

## 3. Request metadata

All keys live in `params._meta` of a `tools/call` request. All are OPTIONAL
unless a boundary's policy requires them for a given tool.

### 3.1 `sh.sayagain/intent` (string)

One sentence, in the agent's words, stating what this call is meant to
accomplish. SHOULD be at most 280 characters. It describes purpose, not
mechanism: "record the customer's refund so the invoice closes" rather than
"call stripe.refund with amount 1200".

A boundary MAY use intent for: repair hints when a call fails, ledger
entries, operator display on hold and replay, and comparison against
task-level intent (section 4). A boundary MUST NOT treat this value as
trusted for policy decisions on its own; see section 8.

### 3.2 `sh.sayagain/expect` (string or object)

A postcondition the caller expects to hold after the call succeeds.

- String form: natural language, for example "an issue with this title exists
  in repo X".
- Object form: a read-only probe the boundary MAY execute after the call.

```json
{
  "tool": "get_issue",
  "arguments": { "repo": "acme/api", "number": "$result.number" },
  "assert": "result.title == 'Flaky login test'"
}
```

`$result.<path>` references the result of the original call. The `assert`
language is boundary-defined in v0.1; boundaries MUST document it. A
boundary MUST NOT execute a probe whose tool is not annotated read-only.

### 3.3 `sh.sayagain/task` (string)

Opaque identifier grouping calls into a task. Boundaries use it for repair
budgets, blast-radius policies and ledger grouping. Clients SHOULD reuse the
same value for every call in a task. When absent, a boundary MAY fall back
to a heuristic (connection plus time window) and MUST mark budgets derived
that way as approximate in its ledger.

### 3.4 `sh.sayagain/idempotency-key` (string)

A client-chosen key, unique per logical operation. A boundary that receives
two `tools/call` requests with the same key and the same tool name within its
retention window MUST NOT execute the second; it MUST return the stored
result of the first with `sh.sayagain/status` set to `"deduplicated"`. The
key does not make the downstream server idempotent; it prevents the boundary
from forwarding the same logical operation twice.

### 3.5 `sh.sayagain/policy` (object)

Per-call override, subject to the boundary's precedence rules (boundary
policy wins over client policy for tightening; client policy may only
tighten, never loosen).

```json
{ "hold": "always" }
```

`hold` is one of `"auto"` (default; boundary decides from annotations and
its own table), `"always"`, `"never"`. A boundary MUST ignore `"never"` on a
tool it has classified as destructive.

## 4. Task-level intent

A model that has been manipulated into issuing a harmful call can also be
manipulated into stating a matching per-call intent. Drift detection
therefore anchors on **task-level intent** supplied by a party other than
the model: the human's original request, the orchestrator, or the harness.

Task-level intent is supplied out of band, not by the model:

- HTTP transport: request header `Sayagain-Task-Intent` (UTF-8, at most
  2 KB) and `Sayagain-Task` (the task id from 3.3), sent by the host on
  every request for the task; or
- an initialization-time declaration where the transport supports it; or
  boundary configuration keyed by task id.

A boundary that implements drift detection MUST compare the call and its
per-call intent against task-level intent, and MUST NOT report drift based
on per-call intent alone.

## 5. Result metadata

Keys live in `result._meta` of the `tools/call` response the boundary
returns to the client.

### 5.1 `sh.sayagain/receipt` (string)

Unique identifier for this call in the boundary's ledger. MUST be present
on every response that passed through the boundary, including pass-through
responses.

### 5.2 `sh.sayagain/status` (string)

One of:

| Value             | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `executed`        | Forwarded to the server; the result is the server's result.             |
| `repaired`        | Arguments were changed before forwarding; see 5.4. Result is the server's. |
| `held`            | Not forwarded. Awaiting operator or policy approval. See 5.3.           |
| `queued`          | Accepted, not yet forwarded (backpressure or scheduled retry).          |
| `deduplicated`    | Not forwarded; result reproduced from an earlier call with the same key. The response also carries `sh.sayagain/duplicate-of` with the first call's receipt. |
| `dead-lettered`   | Retries and repairs exhausted; stored for operator review.              |

### 5.3 `sh.sayagain/held` (object)

Present when status is `held`.

```json
{
  "reason": "tool is not annotated idempotent and has destructiveHint",
  "approval": "https://boundary.example/holds/rcpt_01J...",
  "expiresAt": "2026-09-04T12:00:00Z"
}
```

When an operator rejects a held call, the boundary answers with `isError`
true, `status` still `held`, and `held.decision` set to `"reject"`. When a
held call is later approved and executed, its `executed` response carries
`held` with `decision` `"approve"` so the agent can see it waited.

### 5.4 `sh.sayagain/repair` (object)

MUST be present whenever the boundary forwarded arguments that differ from
what the client sent.

```json
{
  "kind": "coerce",
  "changes": [
    { "path": "/limit", "from": "10", "to": 10, "rule": "string-to-integer" }
  ]
}
```

`kind` is one of `coerce`, `rename`, `default`, `model`. A boundary MUST NOT
apply `model` repair (side-model regeneration) to a tool it has classified
as non-read-only without first holding the call.

### 5.5 `sh.sayagain/boundary` (object)

Present on the `initialize` result when a boundary is in the path. A
boundary MUST NOT alter `serverInfo`, `capabilities` or tool names to
announce itself; this key is the only announcement.

```json
{ "name": "sayagain", "version": "0.1.0", "upstream": "notion", "ledger": "sqlite", "shim": false }
```

Clients MAY display it and MUST NOT require it. A boundary MAY additionally
append one sentence to the `initialize` result's `instructions` naming the
boundary and the meaning of the `held`, `repaired` and `queued` statuses;
operators can turn that sentence off.

## 6. Held calls and the client

When a call is held, the boundary returns a normal `tools/call` result with
`isError: false`, a text content block explaining that the call is held and
quoting the receipt, and the metadata in 5.3. This keeps zero-touch clients
working: the model reads the text and can continue, wait, or explain to the
user.

If the client has negotiated the tasks extension
(`io.modelcontextprotocol/tasks`), the boundary MAY instead return a task
reference and complete it on approval.

## 7. Schema shim (zero-touch intent capture)

Most hosts build `tools/call` from the model's tool-use block and cannot add
`_meta`. To capture intent from any host, a boundary MAY rewrite the
`tools/list` response it serves to the client:

- For each tool whose `annotations.readOnlyHint` is not `true`, add optional
  string properties `intent` and (optionally) `expect` to `inputSchema`.
- The injected `intent` property SHOULD carry the description: "One sentence
  stating what this call is meant to accomplish for the user's task."
- On `tools/call`, the boundary MUST remove these properties from
  `arguments` before forwarding and MUST place their values under the
  corresponding `_meta` keys.
- The server MUST never observe the injected properties.
- Property names are configurable to avoid collisions; the boundary MUST
  skip injection when a tool already defines a property with that name and
  MUST record the skip.

Precedence when both are present: native `_meta` wins over shim-captured
values.

## 8. Security considerations

- Per-call intent is model-generated text and may be adversarial. It is
  input to repair heuristics and the ledger, not an authorization signal.
- Task-level intent is the anchor for drift detection and MUST come from a
  trusted channel (section 4).
- Replay of a held or dead-lettered call is an operator action. A boundary
  MUST NOT replay a non-read-only call automatically.
- Ledger entries contain arguments and therefore may contain personal data
  or secrets. Boundaries MUST keep the ledger in the operator's trust domain
  by default. Any shared telemetry MUST exclude arguments and content; see
  ADR-0005.
- Repair budget: at most one repair per call and three per task before
  dead-lettering, unless the operator configures otherwise.

## 9. Conformance

A boundary conforms to this document at **Level 0** if it emits 5.1 and 5.2
on every response and honours 3.4. It conforms at **Level 1** if it also
implements 3.1, 3.3, 5.3, 5.4 and section 6. Drift detection (section 4)
and the schema shim (section 7) are optional features.

## 10. Changelog

- v0.1 (2026-09-04): initial draft.
- v0.1.1 (2026-09-04): added 5.5, the boundary announcement on `initialize`.
- v0.1.2 (2026-09-05): `sh.sayagain/duplicate-of` on deduplicated responses; `held.decision` on rejected and later-approved calls.
