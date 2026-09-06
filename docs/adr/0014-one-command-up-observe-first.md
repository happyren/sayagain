# ADR-0014: One command up, and it observes before it holds

- Status: Accepted
- Date: 2026-09-06

## Context

The proof of this product now needs machines more than it needs code. The
organic A/B (docs/measurement.md 5.4) flips its coin per session, and one
developer produces about twenty independent sessions a month; the harness
(5.6) buys independence but cannot say what real models do. Both get better
with every machine that runs the boundary, so the throughput of onboarding
is the throughput of evidence.

Onboarding was three commands and a restart, and the three things that went
wrong on the author's own machine (ADR-0012) were visible only afterwards.
At the same time the harness produced one result against the boundary that
holds in every cell of its sweep: with nobody answering holds, records are
left in the wrong state at 0.28 a task against 0.10 at the measured rate. A
frictionless install that walks away is exactly that absent operator, so
the smoother the onboarding, the more work a hold-by-default boundary would
silently leave undone.

The people who can run a proxy are the ones who run Claude Code, Cursor,
Codex or VS Code, and they have a terminal. The servers those hosts provide
themselves (a browser, computer use, session tools) never pass through a
config file, so no installer can wrap them; an installer built for people
without a terminal would be built for traffic the boundary cannot see.

## Decision

**`sayagain up` is the whole onboarding, and it says what it will do before
it does it.** It finds every host config file, prints a numbered plan (which
servers it will wrap and for which hosts, that it will start the daemon,
that it will bring up the daemon's page and where, and whether anything
will wait for the operator), then imports every server with rewrite, starts
the daemon if none is running, prints the page's URL (`--open` opens it),
says which traffic stays outside and why, and ends with `sayagain doctor`.
`sayagain down` puts every host back, stops the daemon, and keeps the
ledger, holds and backups. `--dry-run` prints the plan and changes nothing.

**A fresh install observes first.** `up` writes a daemon-level hold default
of `never` (`daemon.hold` in `config.json`), which servers with a hold mode
of their own override. Receipts, dedupe, safe retries, argument repair and
error guidance are on; nothing waits for a person. `sayagain up --hold`
removes the default, and the boundary as shipped (ADR-0004) is back. The
page and `sayagain doctor` both say which mode is on and how to change it.

**A read-back does not need a hold.** With holds off, a write whose outcome
is unknown is still read back through the verifier its tool declares
(spec 8.3): present, and it is answered as executed; absent, and it is sent
once more; neither, and it gets the failure it got, as it would have without
a read-back. The hold was never what made the read-back safe; the pre-image
and the narrow reading of absence were, and both apply here.

## Consequences

- One command, one restart of the hosts, and the plan is on the screen
  before anything changes. What the command cannot do is named in its own
  output rather than discovered from the ledger.
- ADR-0004's hold-by-default still governs `wrap`, `serve` and `add`; `up`
  is the one path that starts without it, and it says so on every run of
  `doctor` until `--hold` is given.
- The harness gains `--hold never`, the unattended-install cell. Over 300
  paired tasks (docs/measurement.md 5.6): at the measured rate every harm
  row matches the control arm and nothing is left undone, at 0.01 more
  server calls a task; at the stress rate non-idempotent duplicates fall
  from 0.07 a task to 0.01, the same as with an approving operator, at 0.13
  more server calls against that operator's 0.31, with nobody deciding
  anything. Without the read-back the duplicates stay at 0.07.
- A user who runs `up` and never runs `--hold` gets receipts, dedupe,
  retries, repairs and read-backs, and no protection from a destructive
  call that should have been stopped before it went. That is the honest
  trade at install time; the alternative is work left undone by a hold
  nobody answers.

## Alternatives considered

- **A graphical installer for people without a terminal.** The hosts those
  people use provide their servers themselves; nothing an installer writes
  reaches them.
- **Hold by default at install, as `serve` does.** Measured: the largest
  effect the boundary has on an unattended machine, and it is against it.
- **Ask at install time.** A question at the start of a one-line command is
  a decision taken before the page has shown what the boundary sees; the
  page first, then the decision.
