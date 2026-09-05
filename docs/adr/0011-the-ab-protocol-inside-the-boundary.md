# ADR-0011: The A/B protocol runs inside the boundary, with a control arm that observes only

- Status: Accepted
- Date: 2026-09-06

## Context

`docs/measurement.md` 5.4 pre-registered the proof that the boundary
works: the same agents and tools, the proxy toggled per task by a coin
flip logged in the ledger, a minimum of two weeks or 2,000 tool calls per
arm, whichever is later, the primary outcome M15b (tokens saved per 1,000
calls) and the secondaries M15c, M15f and M15e. Until now the only way to
run the control arm was to remove the boundary from the host's
configuration, which also removes the instrument: without the boundary
there is no ledger row for the control calls, so the two arms would be
measured by different means.

The owner will not buy a domain or launch until this proof is in. It has
to run on one developer's traffic, where MCP calls are a few thousand a
month, so it must cost nothing in attention and lose no calls.

## Decision

The control arm is a mode of the boundary, not its absence. A daemon in
`--arm coinflip` assigns each host session an arm when the session is
created; `--arm daily` hashes the UTC date so every session of a day, on
every server, lands in the same arm, and follows the calendar (a session
that crosses midnight changes arm with the day); `--arm control` and
`--arm treatment` pin one arm; `--arm off` ends the experiment. The mode
persists in `config.json`, so a daemon the shim restarts keeps it. A
`wrap` takes the same option for its one session. The arm is set on the
session, copied onto every pending call, written on every ledger row, and
kept on a hold so a call resumed after a restart still carries it.

In the control arm the boundary forwards a call as it came and records
the outcome. It does not apply a learned coercion, look up, reserve or
remember a duplicate, hold a destructive or unknown-outcome write, retry a
retryable failure, repair a coercible one, append a learned hint or the
guidance sentence to an error, augment `tools/list` descriptions, or add
its announcement to `initialize` instructions. A call the upstream never
answers is reported to the host as unanswered, not dead-lettered. The
model in a control session reads nothing from the boundary; only the
host-facing `_meta` (receipt and status) differs from no boundary at all,
because the ledger needs the receipt. The treatment arm is the boundary
as shipped, and the learning loop keeps running during the experiment on
treatment rows only: it never derives evidence from control rows and
never measures lift on them, since a control call has no coercion
applied and would measure the loop's absence.

The unit of randomisation is the host session (one MCP connection), not
the task the original 5.4 named: the ledger has no task boundary unless
the host sends one, and a session is what the daemon can see. With
`coinflip`, one Claude Code session can hold a control connection to one
server and a treatment connection to another; the rows still carry the
right arm each, and the analysis is per row. A host that sends no session
id has nothing to randomise per session, so under `coinflip` it keeps one
arm for the daemon's lifetime; a shim that reconnects starts a new
session and a new coin. With `daily` the whole day is one arm, which is
the design to use when the transcript audit's dollars are wanted per arm;
it trades independence for joinability, since the arm is a hash of the
date, predictable in advance and confounded with day-of-week and
workload. `coinflip` is the default of the pre-registration.

`sayagain report --ab` splits the ledger by arm, computes each arm with
the report's definitions, prints the number of sessions (clusters) per
arm, and prints the differences, control minus treatment (positive
favours the boundary), with 95% intervals, risk first: unacknowledged
writes per 1,000 writes (Newcombe's hybrid score interval), the failure
tax as recovery bytes per call (a normal interval on Welch's standard
error over the per-call series), and the failure rate (Newcombe). It
states how many calls and days the experiment still needs before the
pre-registered minimum, and counts rows that carry no arm as outside the
experiment. "Distinguishable" means the 95% interval excludes zero; it is
not a test at a stated alpha, and the three intervals are not corrected
for one another. The decision rule, read once at the minimum, is in
`measurement.md` 5.4.

## Alternatives considered

- **Toggle the boundary off in the host's config for control tasks.**
  Loses the instrument for the control arm and asks the operator to
  remember which day is which.
- **A shadow daemon that only records.** A second process and a second
  ledger to merge; the same code path with the actions switched off is
  the same instrument by construction.
- **Two daemons on two ports, hosts split by configuration.** Two ledgers
  to merge, and the split is by host, not by session, so a host's habits
  become the arm.
- **An external harness that replays scripted tasks under both arms
  (the 5.3 style).** Measures a script, not the operator's workload, and
  costs the attention the proof must not cost. It remains the right tool
  for the fixture-based sections.
- **Randomise per call.** Would put a call and its retry in different
  arms and make recovery windows meaningless.
- **Measure tokens on the ledger.** The wire carries bytes; tokens are in
  the transcripts. The ledger's bytes are the primary cost outcome here,
  and `--arm daily` lets `sayagain audit` supply dollars per arm-day.

## Consequences

- The proof needs three commands and about a month of ordinary work at
  this machine's MCP rate:

  ```
  sayagain import --host claude-code --rewrite --no-start
  sayagain serve --arm coinflip --detach
  sayagain report --ab
  ```

  (`import --rewrite` would otherwise start a daemon without an arm;
  `report --ab` reads 30 days by default.)
- A control session sees the upstream's raw errors, so an operator running
  the experiment gives up the boundary's help on half their sessions for
  its duration. That is the price of the number.
- There is no blinding: the operator, who is also the agents' user, can
  see the arm in the daemon log and in the sessions' behaviour. The
  operator's hold decisions are part of the treatment: an approved hold is
  an acknowledged write, a pending one is not, and a model's own retry does
  not acknowledge a control-arm write. The measured effect is the whole
  intervention, mechanical actions and model-facing text together, not the
  retry or the repair alone.
- The treatment is not frozen: the boundary keeps learning from treatment
  rows during the experiment, as it would in use. An operator who wants a
  fixed treatment disables the loop (`wrap --no-learn`, or leaves
  `learned.json` empty) for the duration.
- The report's intervals treat calls as independent; sessions cluster
  calls, so a borderline result should be read against the cluster count.
  The pre-registered minimum, not the interval alone, ends the experiment.
- Rows without an arm (from before the experiment, or from a daemon
  restarted with `--arm off`) are excluded, so the report cannot be
  diluted by accident; the count of them is printed.
