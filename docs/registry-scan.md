# Registry scan, 2026-09-05

The first run of `sayagain lint --registry` (docs/measurement.md 5.5), and
the first two per-agent baselines from `sayagain audit --project`. The
Phase 0 numbers in docs/ROADMAP.md.

## The number

Half of the tools that public MCP servers publish carry no documented
parameter constraints: **M16 = 49.9%** (95% interval 48.3 to 51.4) of
3,963 tools listed by 229 servers, rule set 2026-09-05. Within a server the
median share is 33.3%, and 180 of the 229 servers list at least one such
tool. Almost half the tools declare no annotations (48.7%), and 45.2% say
nothing about what they return. Only 12.3% grade A.

## The page

```
Registry scan: 2026-09-05, rule set 2026-09-05, https://registry.modelcontextprotocol.io/v0/servers
Servers listed 27183, with a Streamable HTTP remote 14547, probed 400 (random sample, seed 20260905)

Probe outcomes (no credentials sent)
  ok              229  57.3%
  auth            110  27.5%
  unreachable      37  9.3%
  not-mcp          24  6.0%
  no-tools          0  0.0%

Tools graded: 3963 from 229 servers
  grades       A 489 (12.3%)  B 721 (18.2%)  C 1264 (31.9%)  D 660 (16.7%)  F 829 (20.9%)

M16, tools without documented parameter constraints: 49.9% (95% interval 48.3 to 51.4, n = 3963 tools)
  per server: 180 of 229 servers list at least one such tool; median share within a server 33.3%
  coverage: only servers with a Streamable HTTP remote were probed, without credentials; package-only and SSE-only servers are listed, not probed.
  the interval treats tools as independent and ignores that they cluster by server; the denominator is every tool a server that answered listed, parameterless tools included
Share of tools with a finding, per rule
  annotations/present           48.7%
  description/length             2.9%
  output/described              45.2%
  params/closed                   78%
  params/constrained            49.9%
  params/described              26.1%
  params/required-listed        29.1%
```

## How to read it

- The sample is 400 of the 14,547 servers that publish a Streamable HTTP
  remote, drawn with seed 20260905. The other 12,636 listed servers ship as
  packages or SSE-only remotes and were not probed. The full scan of every
  remote is the target; it takes hours and runs as a background job.
- 27.5% of the sampled servers answered the unauthenticated probe with
  401 or 403, 9.3% did not answer in time or failed, and 6.0% answered with
  something other than MCP (a 404 or a web page). The graded tools come
  from the 57.3% that listed them freely.
- M16's denominator is every tool those servers listed, tools without
  parameters included, so the number is conservative. The interval treats
  tools as independent draws; one server listed 308 tools.
- `params/constrained` is a heuristic: numbers without bounds; strings
  whose name (snake or camel case) or description reads as an id, date,
  time or choice, without a format, pattern, enum, const or length bound.
  docs/measurement.md 5.5 states the word list; a change to it is a new
  rule-set version.
- The per-server results (registry names, remote URLs, outcomes, tool
  names and findings, all public registry data) stay out of the
  repository. `sayagain lint --registry --sample 400 --seed 20260905 --out
  scan.json` reproduces them.

## Baselines on our own agents

`sayagain audit --project <name> --since 90d`, run on 2026-09-05 over the
build machine's Claude Code and Codex transcripts; dollars are
API-equivalent at list prices. The full reports stay out of the repository.

| Agent | Sessions | Calls (MCP) | Unacknowledged writes per 1K writes | Failure tax per 1K calls | Failures, recovered | Retried, of which identical |
| ----- | -------- | ----------- | ----------------------------------- | ------------------------ | ------------------- | --------------------------- |
| quantbot (Claude Code and Codex) | 22 | 15,175 (988) | 1.6 (20 of 12,441) | $32.97 (13.9% of spend) | 399, 354 | 88.7%, 9% |
| this repository's build sessions | 1 | 1,401 (55) | 0.9 (1 of 1,166) | $59.83 (20.3% of spend) | 48, 42 | 87.5%, 7.1% |
| the delivery flywheel | no transcripts on the build machine | | | | | |

Both agents lose more than a tenth of their spend to recovery windows,
and roughly one write in a thousand ends without a known outcome. The
delivery flywheel's baseline waits for its transcripts.
