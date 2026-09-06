# SEP draft: intent, idempotency and compensation for MCP tool calls

- Status: not yet submitted (no sponsor yet)
- PR number: none yet (0000)
- Type: Standards Track (an optional `_meta` convention; Extensions Track if
  the process prefers it there)
- Author: Kaixiang Ren (happyren)
- Created: 2026-09-05
- Reference implementation: `@sayagain/proxy`, `@sayagain/sdk`, `@sayagain/lint`; the convention in `spec/intent-metadata.md` (v0.1.9)

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
non-idempotent call with the same arguments. Measured with `sayagain audit`
over ninety days of two agents' own transcripts (docs/registry-scan.md):
88% of failures were retried, 7 to 9% of them with identical arguments,
and 0.9 to 1.6 non-read-only calls per thousand ended without a known
outcome. Across a seeded sample of 400 public registry servers (the same
document), half of the tools listed carry no documented parameter
constraints and a third declare no annotations, so the protocol's existing
`readOnlyHint`, `destructiveHint` and `idempotentHint` cannot carry the
load on their own.

What is missing is not a new transport but three facts that the parties
already know and do not state: why the call is being made, what makes two
calls the same, and how to take one back. `_meta` exists for exactly this
kind of extension, with reverse-DNS keys so conventions can coexist.

## Specification

The keys below are written with the `sh.sayagain/` prefix, the namespace
of the reference implementation; a SEP would settle on the protocol's own
prefix or a neutral one. The normative text is reproduced here; the fuller
document with examples is `spec/intent-metadata.md`. A receiver that does
not understand a key MUST ignore it, as MCP already requires for unknown
`_meta` keys.

### 1. Request metadata (client to server, `tools/call` `params._meta`)

- `intent` (string). What the call is for, in the client's words. A
  receiver MUST NOT execute or authorise anything on the strength of it;
  it MAY record it, carry it into a held-call record or a receipt, and
  compare it with what the call did after the fact.
- `expect` (string or object). What the client expects back. As a string,
  a description. As an object, a read-only probe the receiver MAY run
  after the call: `{ "tool": "<name>", "arguments": { ... }, "assert":
  "<description>" }`. A receiver MUST NOT run a probe whose tool is not
  read-only.
- `task` (string). A client-chosen identifier grouping the calls of one
  job. Budgets and drift comparison are scoped by it.
- `idempotency-key` (string). Unique per logical operation. A receiver
  that has executed a `tools/call` with the same key and the same tool
  name within its retention window MUST NOT execute the second; it MUST
  return the stored result of the first with `status` set to
  `deduplicated` and `duplicate-of` set to the first receipt. The key does
  not make the server idempotent; it stops the same operation being
  forwarded twice.
- `policy` (object). A per-call tightening, `{ "hold": "auto" | "always" |
  "never" }`. A receiver MUST ignore a value that loosens its own policy
  and MUST ignore `never` on a tool it classifies as destructive.

### 2. Tool declarations (server to client, tool definition `_meta`)

- `idempotency` (object): `{ "key": "<argument name>" }`. The argument
  whose value identifies the logical operation: two calls with the same
  value are the same operation. A receiver MAY use it as the idempotency
  key when the client sent none. A tool with `idempotentHint: true` needs
  no declaration.
- `compensation` (object): `{ "tool": "<name>", "arguments": { ... } }`,
  the call on the same server that undoes this one, with template values
  that are literals, `$arguments.<name>` (an argument of the original
  call) or `$result.<path>` (a dotted path into its structured result); or
  `{ "none": "<why>" }` when the effect cannot be undone. Running a
  compensation is an operator action, or the policy of a unit of
  commitment the client declared. A receiver MUST NOT run one
  automatically for a single call, and MUST NOT run one on another server
  than the one that declared it.

### 3. Result metadata (server or intermediary to client, `result._meta`; on a JSON-RPC error, `error.data`)

- `receipt` (string). An identifier the receiver assigns to every call it
  handles, unique per call. A deduplicated or replayed response carries
  its own receipt and names the earlier one in `duplicate-of` or
  `replay-of`.
- `status` (string). One of `executed`, `repaired`, `held`, `queued`,
  `deduplicated`, `dead-lettered`. A receiver that emits `receipt` MUST
  emit `status` on the same response.
- `held` (object). Why a call waited (`reason`, `mode`) and, once decided,
  `decision` (`approve` or `reject`) and `cancelled`.
- `repair` (object). What changed in the arguments before the call
  succeeded: a list of `{ "path", "rule", "from", "to" }` changes, the
  rule name, and the values the rule replaced, so the client can see what
  was sent. Argument values that were not changed are never included.
- `duplicate-of`, `replay-of` (string). The receipt this response
  repeats or replays.
- `boundary` (object, on the `initialize` result). The intermediary's
  announcement: its name and version, the ledger it keeps, and its hold
  policy, so its presence is not a surprise.

## Rationale

- **`_meta`, not new fields.** The protocol reserves `_meta` for this. No
  message changes shape; a client and a server that ignore the convention
  interoperate unchanged.
- **Intent is evidence, not authority.** No party executes or authorises
  on it; a proxy compares it to what the call did after the fact and
  reports drift. That keeps the convention out of the planner's seat: it
  returns verdicts, it does not act.
- **Idempotency is two-sided.** The client's key covers operations the
  server cannot recognise; the server's declaration covers clients that
  send no key. A receiver honours whichever it has.
- **Compensation is declared, not inferred.** The server knows what undoes
  a call; nobody else should guess. `{ "none": ... }` is a declaration too,
  and the honest one for an email.
- **Informational linting.** A definition without a compensation key is not
  wrong; it is unfinished. The reference linter says so at info level so
  scores do not punish servers before the convention exists.

## Backward compatibility

Fully compatible. Every key is optional and lives in `_meta`. Existing
servers, clients and hosts see no change. A host that strips unknown
`_meta` keys loses the convention's benefit and nothing else; a schema
shim (`spec/intent-metadata.md` section 7) exists for hosts that cannot
forward `_meta`.

## Reference implementation

- `@sayagain/proxy` emits every result key and honours `intent`, `task`
  and `idempotency-key` (conformance Level 1 of the convention); `expect`
  probes and per-call `policy` are specified and not yet implemented.
- `@sayagain/sdk` builds request metadata and the schema shim.
- `@sayagain/lint` checks tool definitions, including
  `annotations/compensation`.
- The registry scan (`sayagain lint --registry`) and the Tool Reliability
  Index (`sayagain index build`) give the numbers above and can track
  adoption of the declarations across the public registry.

## Security implications

- `intent` and `expect` are client text and MUST be treated as untrusted by
  anyone who reads them; they are never executed or interpreted as
  instructions.
- A compensation declaration names a tool on the same server. A receiver
  MUST NOT run a compensation on another server, and MUST NOT run one for
  a single call on its own initiative.
- Result metadata may reveal that an intermediary exists. The intermediary
  announces itself on `initialize` (`boundary`) so this is not a surprise.
- Idempotency keys are client-chosen; a receiver bounds its retention and
  scopes keys per session or per client to keep one client from replaying
  another's result.

## Open questions

- The namespace: `sh.sayagain/` today; a SEP would move the keys under
  the protocol's own prefix or a neutral one.
- Whether `compensation` belongs in `annotations` (typed, protocol-owned)
  rather than `_meta` once the shape is stable.
- Whether `status` values need to be an open set for other intermediaries.
