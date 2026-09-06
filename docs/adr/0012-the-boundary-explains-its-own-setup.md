# ADR-0012: The boundary explains its own setup, and proposes classes it will not apply on its own

- Status: Accepted
- Date: 2026-09-06

## Context

Onboarding is two commands (`sayagain import --host all --rewrite`, then a
host restart) and it appears to work. Three things went wrong anyway on the
author's own machine, and none of them was visible from the outside:

- A server was wrapped in one project's configuration and called directly
  from every other directory. Its calls never entered the ledger, so the
  report was quietly missing a third of the traffic.
- A stdio server that finds its index by the current directory was started
  by the daemon from the daemon's own directory. Every call failed with the
  server's own "no project loaded" error, which reads like a bug in the
  server.
- A design server annotates twelve of its thirteen tools `destructiveHint:
  true`, screenshots and layout reads included. Under the default hold
  policy every one of those calls waited for an approval. The operator sees
  slow tools, not a policy.

All three were found by reading the ledger by hand. The tool had the facts to
find them itself in every case: it knows which host files it rewrote, which
entries carry a project, and what each server declares.

ADR-0004 makes the class the hinge of the whole boundary: a read-only call is
retried and may be coerced before it leaves, a destructive one is held. A
server that declares nothing leaves every tool on the cautious fallback, which
is safe and wrong: no retry, no pre-send coercion, and a write in the
denominator of the north-star rate. A server that declares badly is worse,
because the boundary believes it.

## Decision

**`sayagain doctor` is the one command that reads the setup and says what to
run.** It checks the daemon, every host file in every scope, every registered
server, and the last week of the ledger, and prints findings ordered by
severity with the exact command that addresses each. It exits 1 when something
is broken, so it can gate a script. `import --rewrite` and `install` end by
naming it.

**`sayagain classes` shows the class of every tool and where it came from**:
the operator's table, the server's annotations, or the fallback. Each row says
what the boundary does with that class, so "held on every call" is a fact the
operator can read rather than infer.

**The tool proposes a class; it never applies one on its own.** `--suggest`
adds the class a tool's name implies where it differs from the class in force,
and `--write` stores those in `config.json`. The suggestion rules are
deliberately timid:

- A suggestion that *raises* the class (an undeclared `delete_*` that the
  fallback calls a write) is always offered: the cost of being wrong is one
  extra hold.
- A suggestion that *lowers* it is offered only when the name reads like a
  read (`get_`, `list_`, `search_`, …). A tool the server calls destructive
  and names `export_nodes` is left alone, because treating a write as
  read-only has unbounded cost and a verb is not evidence enough.
- A tool the operator has already overridden is never second-guessed.

**A class table written while the daemon runs takes effect without a
restart.** Classes and the hold mode are pure policy: no session, pending call
or upstream process depends on them, so the daemon re-reads the registry and
updates the live boundary in place (`POST /api/policy/reload`).

**`import` carries a project-scoped server's directory over as its working
directory.** That is what the host did; the daemon should not silently change
it. A user-scope entry has no project to inherit, so nothing is guessed there
and `doctor` says so instead.

## Alternatives considered

- **Infer classes from names and apply them.** Fastest onboarding, and wrong
  the first time a tool called `update_index` refreshes a cache and a tool
  called `get_lock` acquires one. The boundary's promise is that a commitment
  is held; a heuristic that silently unholds one breaks it.
- **Ask the model to classify the tools.** A side model reading tool
  descriptions would classify better than a verb list. It also costs money per
  server, needs a key at onboarding time, and puts a non-deterministic step in
  the path of the safety property. The verb list is a proposal an operator
  reads in ten seconds; the model can come later, behind the same review.
- **Warn at call time instead of in a command.** A warning in the daemon log
  when a `get_*` tool is held is cheap, but the log is not where an operator
  looks during onboarding, and a per-call warning is noise for the many
  servers that are annotated correctly.
- **Make `import` refuse to wrap a server whose annotations look wrong.**
  Refusing to onboard because a third-party server has bad metadata punishes
  the operator for someone else's schema.

## Consequences

- The linter's judgement of a server (`sayagain lint`) and the boundary's
  behaviour towards it (`sayagain classes`) are now two views of the same
  facts, and `doctor` points at whichever one applies.
- The suggestion rules will miss tools whose names carry no verb
  (`batch_get`, `snapshot_layout`). They are listed in the table with their
  source, so the operator can still see they are on the fallback; the tool
  simply has nothing to propose.
- `doctor` starts every registered upstream when it probes, which is the
  point (it cannot see the tools otherwise) but makes it slower than the rest
  of the CLI. `--no-probe` keeps the configuration checks alone.
- Class changes now take effect mid-session. An operator who writes a table
  while an agent is working changes the policy under it, which is the
  behaviour asked for; the ledger records the class each call actually ran
  under.
