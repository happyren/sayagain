# Half the tools in the MCP registry do not say what their parameters may hold

Draft of the data post for the index launch. Numbers from
docs/registry-scan.md (2026-09-05, rule set 2026-09-05; rule set
2026-09-05.1 adds one informational rule, so the numbers reproduce under
it) and the two per-agent baselines; update both when the full scan runs.

## The headline

We asked 400 servers from the public MCP registry, drawn at random from
the 14,501 that publish a Streamable HTTP endpoint, to list their tools.
216 did without asking for credentials. They listed 3,253 tools. Of those,
**49.6% carry no documented parameter constraints**: a string that reads as
an id, a date or a choice with no format, pattern or enum, or a number
with no bounds (95% interval 47.8 to 51.3). 33.8% declare none of the
three annotations a host needs to know whether a call is safe to retry
(read-only, destructive, idempotent). 37.9% do not say what they return.
13.3% of tools grade A on the linter; 20.4% grade F.

A schema that does not say what a value may hold cannot reject a wrong
one early, and cannot tell a model what a right one looks like. The model
sends a plausible value, the server rejects it or does something else with
it, and the next few calls are spent finding out which.

## What that costs

On one developer's agents, measured from their own transcripts with the
same analysis (`sayagain audit`, 90 days, dollars at list prices):

| Agent | Calls (of which MCP) | Writes that ended without a known outcome, per 1K writes | Failure tax per 1K calls | Failures retried, of which identical |
| ----- | -------------------- | -------------------------------------------------------- | ------------------------ | ------------------------------------ |
| a trading-research agent (Claude Code and Codex) | 15,175 (988) | 1.6 | $32.97 (13.9% of spend) | 88.7%, 9% |
| this project's own build sessions | 1,401 (55) | 0.9 | $59.83 (20.3% of spend) | 87.5%, 7.1% |

The tax covers every tool the agents called, the hosts' built-in file and
shell tools included, not only the MCP ones. Between a tenth and a fifth
of what these agents spend goes into recovery windows: the calls after a
failure until the same tool succeeds again. Roughly one write in a
thousand ends without anyone knowing whether it happened. Those are two
agents on one machine; the mis-call rate and the calls to recover across
contributed sessions will replace this table as contributions arrive.

## What a maintainer can do in an afternoon

The index lists, per server, the two changes that move its score most.
Across the sample the same two come up again and again:

1. Describe every parameter. 27.5% of tools have at least one with no
   description, and that is the finding the grade punishes hardest.
2. Put the constraint in the schema, not in prose: an `enum` for a choice,
   a `format` for a date or an id, `minimum` and `maximum` for a count.
   That is the 49.6%.

Then a sentence about what the tool returns (37.9% say nothing), the
three annotations (33.8% declare none), a `required` list (32.8% have
none), and `additionalProperties: false` so stray arguments fail fast (81%
leave the schema open; that last one does not move the grade).

## How we counted

- The registry listing is the official one, active servers, latest version
  each. Only servers with a Streamable HTTP remote were probed, without
  credentials; package-only and SSE-only servers are listed, not probed.
  Servers that want credentials (34.8% of the sample) contribute no tools.
- The interval treats tools as independent draws and ignores that they
  cluster by server; 158 of the 216 servers list at least one
  unconstrained tool, and the median share within a server is 33.3%.
- The constraint check is a heuristic with a stated word list
  (docs/measurement.md 5.5); a change to it is a new rule-set version, so
  the number can be reproduced: `sayagain lint --registry --sample 400
  --seed 20260905`.
- Dollar figures are API-equivalent at list prices; a subscription pays
  differently. Argument values, results and prompts never leave the
  machine that produced a report (ADR-0005, ADR-0009).

## What next

The index page per server, a badge per tool, and the message to each
maintainer with their score and two fixes. The contribution flow
(`sayagain contribute`) adds runtime scores as shapes arrive: failure
rate per model family, the resolution that worked, and a rewrite
suggestion. The convention that makes calls safe to hold and replay
(`_meta` intent, idempotency and compensation declarations) is in
docs/sep-draft.md.
