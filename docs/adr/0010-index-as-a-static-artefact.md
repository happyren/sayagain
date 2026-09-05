# ADR-0010: The Tool Reliability Index is a static artefact built from the scan and the contributions

- Status: Accepted
- Date: 2026-09-05

## Context

ADR-0009 defines the index (per public MCP tool, a static score from the
linter and a runtime score from contributed shapes) and postpones three
decisions: the contribution endpoint, its hosting, and the owner of the
data policy (decision 3). Phase 1 of the roadmap asks for the index to be
public with a badge per tool and a link per server, a data post, and
outreach with "your score and two fixes".

The scan already produces everything the static side needs
(`lint --registry --out`), and the contribution documents are on disk in
a schema that carries only aggregates. Nothing about the index requires a
server: it is a function of two files.

## Decision

`sayagain index build` turns a registry scan and a directory of
contribution documents into a directory of static files: `index.html`,
one page and one SVG badge per graded server, one badge per tool, and
`index.json`. `sayagain index fixes <server>` prints the outreach message
for one maintainer. A GitHub Actions workflow (`index.yml`) runs the scan
and the build on demand and, when the repository variable
`SAYAGAIN_INDEX_PAGES` is `true`, publishes the directory to GitHub Pages;
the weekly schedule runs only when `SAYAGAIN_INDEX_SCHEDULE` is `true`.
Flipping those variables is the hosting decision, left to the owner.

Scoring: a tool's static score is its linter grade (A 100, B 80, C 60,
D 40, F 20); a server's is the mean over its tools, graded again at 90,
70, 50 and 30. A runtime score is 100 minus the failure rate over the
contributed calls for that tool, shown with the most frequent error class,
the per-family counts, the most-recorded resolution, and the audit's
suggestion for that error class (operator wording; a maintainer-facing
rewrite suggestion waits for real runtime data). Contributions are matched to registry servers
by name (the registry name, or its last segment, lowercased). The "two
fixes" are the two rules whose findings weigh most across the server's
tools (error 3, warning 1, per tool; informational findings never move a
grade and are never a fix).

What the site carries: registry names, versions and remote URLs (public
registry data), grades, findings, and aggregates over shapes (counts,
including a session count). What it never carries: contributor ids,
consent records, session ids, receipts, argument shapes, signature hashes,
error text, or anything from the local ledger.

## Alternatives considered

- **A hosted application with a database.** Needs the endpoint, hosting and
  data-policy decisions first; the static site needs none of them and is
  the same pages.
- **The index inside the daemon's operator page.** Wrong audience: the
  index is for maintainers and the public, the page for an operator.
- **A badge service that computes on request.** A server is a moving part
  that must be kept up; a badge that is a file in a directory is not.
- **Scores from the runtime data only.** Runtime data exists for a handful
  of servers until contributions arrive; the static score covers every
  server that answered.

## Consequences

- The index exists as a build output from 0.12.0 on; whether it is public
  is one repository variable. The data post and the outreach text can be
  produced from the same build.
- Runtime scores are only as good as the name match between a host's
  configuration key and the registry name. A contribution whose server
  name matches nothing appears nowhere; the contributor's own page
  (ADR-0009 step 4) waits for the endpoint.
- The scoring formula is part of the rule set's meaning: a change to the
  grade weights or the thresholds is a new `RULE_SET_VERSION`.
- The scan sample decides which servers have a page. The full scan is the
  target; until it runs, a maintainer whose server was not sampled has no
  page and can run `sayagain lint --file` on their own definitions.
