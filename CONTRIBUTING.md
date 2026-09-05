# Contributing to Say Again

Thanks for considering a contribution. This document covers the mechanics.
Design questions go to Discussions or an ADR; see below.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](DCO). Add it with:

```bash
git commit -s
```

Use your real name and a reachable email address. Pull requests with
unsigned commits fail the DCO check. Commits authored by bots (Dependabot)
are exempt; a maintainer reviews and merges them like any other change. We use the DCO instead of a CLA on
purpose: it is lighter, it is what the Linux Foundation and its sub-foundations
use, and it keeps the project relicensable only with every contributor's
consent, which is the guarantee we want to give.

## Setup

```bash
corepack enable pnpm
pnpm install
pnpm check
```

`pnpm check` runs Biome (lint and format), `tsc -b` and Vitest across all
packages. CI runs the same command.

## Commits and pull requests

- Conventional Commits: `feat(proxy): ...`, `fix(lint): ...`, `docs: ...`,
  `spec: ...`. Scope is the package or area.
- One logical change per PR. Squash-merge is the only merge mode.
- Tests accompany behaviour changes. Spec changes update
  `spec/intent-metadata.md` and its changelog section in the same PR.
- Anything that touches arguments of a non-read-only tool, the hold path, or
  replay requires a second review and a note in the PR describing the
  side-effect analysis.

## Decisions

Non-trivial design changes are recorded as an ADR in `docs/adr/`. Copy
`docs/adr/0000-template.md`, number it, open a PR. ADRs are accepted by the
maintainers listed in `GOVERNANCE.md`.

## Reporting a badly documented tool

The linter and the whitepaper are fed by real examples. Use the
"Tool definition report" issue template to submit an MCP tool whose
description or schema caused a wrong call. Do not include secrets, user data
or full argument payloads.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
