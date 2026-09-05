# Registry scan, 2026-09-05

The first run of `sayagain lint --registry` (docs/measurement.md 5.5), and
the first two per-agent baselines from `sayagain audit --project`. The
Phase 0 numbers in docs/ROADMAP.md.

## The number

Half of the tools that public MCP servers publish carry no documented
parameter constraints: **M16 = 49.6%** (95% interval 47.8 to 51.3) of
3,253 tools listed by 216 servers, rule set 2026-09-05. Within a server the
median share is 33.3%, and 158 of the 216 servers list at least one such
tool. A third of the tools declare no annotations (33.8%), and 37.9% say
nothing about what they return. 13.3% grade A; a fifth grade F.

## The page

```
Registry scan: 2026-09-05, rule set 2026-09-05, https://registry.modelcontextprotocol.io/v0/servers
Servers listed 26875 (active, latest version each), with a Streamable HTTP remote 14501, probed 400 (random sample, seed 20260905)

Probe outcomes (no credentials sent)
  ok              216  54.0%
  auth            139  34.8%
  refused           1  0.3%
  unreachable      27  6.8%
  not-mcp          16  4.0%
  no-tools          0  0.0%
  skipped           1  0.3%

Tools graded: 3253 from 216 servers
  grades       A 433 (13.3%)  B 789 (24.3%)  C 963 (29.6%)  D 404 (12.4%)  F 664 (20.4%)

M16, tools without documented parameter constraints: 49.6% (95% interval 47.8 to 51.3, n = 3253 tools)
  per server: 158 of 216 servers list at least one such tool; median share within a server 33.3%
  coverage: only servers with a Streamable HTTP remote were probed, without credentials; package-only and SSE-only servers are listed, not probed.
  the interval treats tools as independent and ignores that they cluster by server; the denominator is every tool a server that answered listed, parameterless tools included
Share of tools with a finding, per rule
  annotations/present           33.8%
  description/length             1.5%
  output/described              37.9%
  params/closed                   81%
  params/constrained            49.6%
  params/described              27.5%
  params/required-listed        32.8%
```

## How to read it

- The sample is 400 of the 14,501 active servers that publish a Streamable
  HTTP remote, drawn with seed 20260905. The other 12,374 listed servers
  ship as packages or SSE-only remotes and were not probed. The full scan
  of every remote is the target; it takes hours and runs as a background
  job.
- 34.8% of the sampled servers want credentials: 84 answered the
  unauthenticated probe with 401 and 55 declare a required secret header
  in the registry, so they were counted without a probe. 6.8% did not
  answer in time or failed, 4.0% answered with something other than MCP
  (a 404, a 405, a web page), one answered with a JSON-RPC error, and one
  points at a private address and was never probed. The graded tools come
  from the 54.0% that listed them freely.
- M16's denominator is every tool those servers listed, tools without
  parameters included, so the number is conservative. The interval treats
  tools as independent draws; one server listed 163 tools.
- `params/constrained` is a heuristic: numbers without a bound; strings
  whose name (snake or camel case) or description reads as an id, date,
  time or choice, without a format, pattern, enum, const or length bound;
  a union is judged by its branches and a reference is not judged.
  docs/measurement.md 5.5 states the word list; a change to it is a new
  rule-set version.
- The per-server results (registry names, remote URLs, outcomes, tool
  names and findings, all public registry data) stay out of the
  repository. `sayagain lint --registry --sample 400 --seed 20260905 --out
  scan.json` reproduces them; the registry moves, so the listing counts
  drift between runs.

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
