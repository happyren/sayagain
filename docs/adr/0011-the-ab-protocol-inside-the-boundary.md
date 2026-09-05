# ADR-0011: The A/B protocol runs inside the boundary, with a control arm that observes only

- Status: Accepted
- Date: 2026-09-06

## Context

`docs/measurement.md` 5.4 pre-registers the proof that the boundary
works: the same agents and tools, the proxy toggled per task by a coin
flip logged in the ledger, at least two weeks or 2,000 calls per arm, the
primary outcome the failure tax and the secondary outcomes holds, task
success and overhead. Until now the only way to run the control arm was to
remove the boundary from the host's configuration, which also removes the
instrument: without the boundary there is no ledger row for the control
calls, so the two arms would be measured by different means.

The owner will not buy a domain or launch until this proof is in. It has
to run on one developer's traffic, where MCP calls are a few thousand a
month, so it must cost nothing in attention and lose no calls.

## Decision

The control arm is a mode of the boundary, not its absence. A daemon in
`--arm coinflip` assigns each host session an arm when the session is
created; `--arm daily` hashes the UTC date so every session of a day, on
every server, lands in the same arm; `--arm control` and `--arm treatment`
pin it. A `wrap` takes the same option for its one session. The arm is set
on the session, copied onto every pending call, and written on every
ledger row.

In the control arm the boundary forwards a call as it came and records the
outcome. It does not apply a learned coercion, look up or reserve a
duplicate, hold a destructive or unknown-outcome write, retry a retryable
failure, repair a coercible one, append a learned hint or the guidance
sentence to an error, or augment `tools/list` descriptions. It still
announces itself on `initialize` and still stamps a receipt and a status
on results, because those go to the host's `_meta`, not to the model, and
the ledger needs the receipt. The treatment arm is the boundary as
shipped.

`sayagain report --ab` splits the ledger by arm, computes each arm with
the report's definitions, and prints the differences, control minus
treatment, with 95% intervals: the failure tax as recovery bytes per call
(Welch interval over per-call series), unacknowledged writes per 1,000
writes and the failure rate (Newcombe intervals for rates). It states how
many calls the smaller arm still needs before the pre-registered 2,000,
and counts rows that carry no arm as outside the experiment.

The unit of randomisation is the host session (one MCP connection). With
`coinflip`, one Claude Code session can hold a control connection to one
server and a treatment connection to another; the rows still carry the
right arm each, and the analysis is per row. With `daily` the whole day is
one arm, which is the design to use when the transcript audit's dollars
are wanted per arm.

## Alternatives considered

- **Toggle the boundary off in the host's config for control tasks.**
  Loses the instrument for the control arm and asks the operator to
  remember which day is which.
- **A shadow daemon that only records.** A second process and a second
  ledger to merge; the same code path with the actions switched off is
  the same instrument by construction.
- **Randomise per call.** Would put a call and its retry in different
  arms and make recovery windows meaningless.
- **Measure tokens on the ledger.** The wire carries bytes; tokens are in
  the transcripts. The ledger's bytes are the primary outcome here, and
  `--arm daily` lets `sayagain audit` supply dollars per arm-day.

## Consequences

- The proof needs one command (`sayagain serve --arm coinflip --detach`
  after `sayagain import --host claude-code --rewrite`) and about a month
  of ordinary work at this machine's MCP rate, then `sayagain report --ab`.
- A control session sees the upstream's raw errors, so an operator running
  the experiment gives up the boundary's help on half their sessions for
  its duration. That is the price of the number.
- The report's intervals treat calls as independent; sessions cluster
  calls, so a borderline result should be read with that in mind. The
  pre-registered minimum, not the interval alone, ends the experiment.
- Rows without an arm (from before the experiment, or from a daemon
  restarted without `--arm`) are excluded, so the report cannot be diluted
  by accident; the count of them is printed.
