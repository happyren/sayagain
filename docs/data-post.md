# Half the tools in the MCP registry do not say what their parameters may hold

Draft of the data post for the index launch. Numbers from
docs/registry-scan.md (2026-09-05, rule set 2026-09-05) and the two
per-agent baselines; update both when the full scan runs.

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

The failures this produces are not schema violations. Frontier models are
schema-compliant; they pick the wrong tool, or the right tool with a
plausible-looking value the server rejects, and then spend tokens working
out why.

## What that costs

On one developer's agents, measured from their own transcripts with the
same analysis (`sayagain audit`, 90 days, dollars at list prices):

| Agent | Calls | Writes that ended without a known outcome, per 1K writes | Failure tax per 1K calls | Failures retried, of which identical |
| ----- | ----- | -------------------------------------------------------- | ------------------------ | ------------------------------------ |
| a trading-research agent (Claude Code and Codex) | 15,175 | 1.6 | $32.97 (13.9% of spend) | 88.7%, 9% |
| this project's own build sessions | 1,401 | 0.9 | $59.83 (20.3% of spend) | 87.5%, 7.1% |

Between a tenth and a fifth of what these agents spend goes into recovery
windows: the calls after a failure until the same tool succeeds again.
Roughly one write in a thousand ends without anyone knowing whether it
happened. Those are two agents on one machine; the wrong-tool and
recovery rates across contributed sessions will replace this table as
contributions arrive.

## What a maintainer can do in an afternoon

The index lists, per server, the two changes that move its score most.
Across the sample the same two come up again and again:

1. Close the schema (`additionalProperties: false`, 81% of tools do not)
   and list `required` (32.8% do not). Stray arguments then fail fast
   instead of being silently ignored.
2. Put the constraint in the schema, not in prose: an `enum` for a choice,
   a `format` for a date or an id, `minimum` and `maximum` for a count.
   That is the 49.6%.

Then the annotations, then a sentence about what the tool returns.

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
