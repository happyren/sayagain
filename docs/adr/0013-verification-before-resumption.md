# ADR-0013: A write whose outcome is unknown is read back before it is re-sent or held

- Status: Accepted
- Date: 2026-09-06

## Context

The fault-injection harness (docs/measurement.md 5.6) put the boundary in
front of a server that fails the way real ones do, and measured both arms
against a truth log of what really happened. The result was not the one the
thesis wanted. When a write timed out after it was sent, the boundary held it
and asked an operator; with an operator who approves, the call was re-sent
and could run twice; with one who declines, the record was left in the wrong
state 0.26 times per task against zero without the boundary. (The first
harness lost every attempt's answer, which inflated the approving case to 0.15
duplicates per task; under a lost answer that a retry recovers, approving
without a read-back merely matches the control arm's own retry duplicates.) The hold converted a silent unknown into a decision,
and the decision was lossy in either direction, because it was taken without
knowing whether the write had landed.

The boundary had the means to know. Most servers that create something also
expose a way to read it back, and spec section 8 already lets a tool declare
how it relates to others.

## Decision

**A tool MAY declare how to read its effect back**, `sh.sayagain/verify` in
its `tools/list` `_meta` (spec 8.3): a read-only tool on the same server, an
argument template over the original call's arguments, and whether the
verifier's success or its not-found failure proves the effect is present. A
deletion is verified by an absence.

**After a write ends with an unknown outcome, the boundary runs the verifier
before deciding anything**, when the tool declares one and the verifier is
classed read-only. That includes a destructive call the boundary held before
sending and an operator approved: the approval was about sending it, and the
lost outcome is read back like any other. If the effect is present, the
original call is answered as executed, with `sh.sayagain/verified` on the
result saying which tool was asked, and the agent is told not to repeat it.
If the effect is absent, the world has said that nothing landed, so one
re-send cannot duplicate anything, and the call is sent again without a hold.
If the verifier is inconclusive, the boundary holds the call exactly as
before.

**Absence is a narrow reading.** Only a failure phrased as an absence (`not
found`, `no such`, `does not exist`, `404`, `ENOENT`) says the thing is
missing. The boundary's wider "semantic" failure class also covers `already
exists`, `not initialized` and `call X first`, and a re-send on any of those
would be exactly the duplicate this decision exists to prevent, so they are
inconclusive. A declaration that names nothing from the call, or refers to a
result the boundary does not have, is refused rather than resolved to a
literal, because a verifier that always answers would find every write
present. The linter reports both shapes.

**A client that cancels or leaves while the verifier runs gets no re-send on
its behalf**; the call waits for an operator instead. A verifier that never
answers is recorded as an inconclusive read, not a dead letter to replay.

**The read-back is counted as the work it is.** The verifier is one of the
boundary's own calls and gets its own ledger row, marked with the receipt it
checked. The harness's "calls the server actually ran" row rises by it, and
that row is reported.

**It is on by default and off by policy** (`verify: false`), because a
boundary that can look should look, and an operator who wants every unknown
outcome to reach them can say so.

**The linter asks for the declaration** (`annotations/verify`, informational)
on any tool that is neither read-only nor idempotent, beside the existing
request for a compensation. The index's grades do not move; the rule set
version does.

## Alternatives considered

- **Re-send on approval, as before.** That is what the harness measured, and
  it doubles execution on the writes that matter most.
- **Never re-send; always hold and let the operator verify by hand.** That is
  the rejecting rule, and it leaves work undone at a rate the harness put at a
  quarter of a task. It also asks the operator to do by hand what the server
  can answer in one call.
- **Infer a verifier from names** (`create_x` reads back with `get_x`). A
  guess in the one place where a wrong guess re-executes a write. The
  declaration is the server's own word and costs it one line.
- **Use the idempotency declaration instead** (8.1). Right for tools that
  have one, and the boundary already treats an idempotent write as safe to
  retry. Most creates and deletes are not idempotent, and a verifier is the
  honest alternative to pretending they are.

## Consequences

- With the read-back on, the duplicates the agent's own retries cause fall
  from 0.03 per task to zero and the silent unknowns from 0.02 to zero, both
  distinguishable over 300 paired tasks, and no record is left in the wrong
  state. Failures the agent sees fall from 0.82 to 0.24 per task and calls
  spent recovering from 1.60 to 0.48. The server runs slightly more calls,
  5.37 against 5.30, which is the verifiers, and the bytes delivered to the
  agent roughly double, which is the receipts. Both costs are reported.
- The rejecting rule still leaves destructive work undone, because a
  destructive call declined before it is sent has no outcome to read back.
  That is the hold policy doing what it was asked; an operator who declines
  every delete gets no deletes.
- The harness's first cut lost a write's answer on every attempt, which is
  an outage rather than a lost answer, and made any arm that retries look
  worse than one that does not. It now loses the answer once, and the
  numbers in the consequences above are from that model.
- A verifier that is not read-only is ignored, which keeps a bad declaration
  from turning a read-back into a second write.
- The spec moves to v0.1.8. Servers that already declare compensation gain
  one more line to write; the harness's own server writes it.

## Amendment, 2026-09-06: the pre-image

The harness, once it injected the measured failure mix, found the mirror
error this decision had left open. A destructive call held before sending
was approved and timed out; the verifier read the record as absent; absence
was the declared effect; the call was answered as executed. The record had
never existed: an earlier create had failed and the agent went on. Nothing
had run, and the boundary said something had. The same shape exists for a
create whose id already exists: a verifier that reads the record as present
cannot tell this call's work from the record that was already there.

**A verifier answer that matches the pre-image proves nothing about the
call.** For a call the boundary holds before sending, whether because it is
destructive or because its arguments were repaired, it reads the effect
through the declared verifier while the operator decides, so the read costs
no waiting, and sends the call only once that read has returned, so the
read cannot see the call's own effect. After an unknown outcome, a verifier
that finds the effect present is conclusive only if the pre-image found it
absent; if the pre-image found it present, or could not say, the call is
held as inconclusive, with the reason saying which. The pre-image is one
more of the boundary's own read-only calls, with its own ledger row marked
with the receipt it checked.

A write that is not held before sending has no pre-image, and a verifier
that finds its effect present is read as before, with one exception added
with ADR-0014: an absence is the natural state of most things, so a
verifier whose effect is an absence proves the call only against a
pre-image that read a presence, and without one it is inconclusive. That leaves the create-on-
an-existing-id case open for unheld writes; it is rarer than the destructive
case, since the agent chose the id, and reading before every verifiable
write would cost a call on the path where nothing goes wrong. It is
recorded here as the known limit rather than papered over.

The spec moves to v0.1.9.
