# Roadmap

Revised 2026-09-05 from the roadmap adjustment that followed the session
summary and the pricing bulletin. It replaces the version-per-slice table
that carried 0.1 to 0.8; those versions shipped and are mapped below.

The market read behind the order: the adjacent layers (gateway and auth,
observability, DLP) are crowded and consolidating; this layer (retry,
dead-letter, repair, units of commitment, runtime tool grades) is empty
across the gateways surveyed. The window is twelve to twenty-four months
before a gateway adds a dead-letter queue or the spec absorbs idempotency
and intent. So: narrow, named, convention first. Corpus from history, not
from traffic. Standards published in the order whitepaper rules, linter
rules, index scoring, `_meta` convention, SEP.

## The scope guard

Every feature returns a verdict to the agent or the operator: accept, hold,
reject, repair applied, diagnosis. None acts on the plan. The moment a
warning becomes an automatic plan edit, the boundary has become the planner
and lost its position. ADR-0009 records the audit of what is already built
against this rule and the two changes it requires.

## What shipped before the revision (0.1 to 0.8)

| Version | Slice | Where it lands in the phases below |
| ------- | ----- | ---------------------------------- |
| 0.1 to 0.3 | `wrap`; classify, dedupe, hold; retry, deterministic repair, dead-letter, replay, error rewriting | Phase 3, done early |
| 0.4 | Daemon, Streamable HTTP, stdio shim, registry, SQLite, persisted holds | Phase 3, done early |
| 0.5 | Onboarding: `import --rewrite`, launcher, `eject` | Phase 3, done early |
| 0.6 | Ledger analysis: `tools`, `errors`, `report`, OTLP spans, `lint` | Phase 0 and 1 groundwork (the same signatures, recovery paths and rankings the index scores from) |
| 0.7 | Operator page served by the daemon | Phase 3 ("replay UI"), done early |
| 0.8 | Learning loop: learned coercions, hints, lift, revert | Phase 4 territory, shipped early; pre-send coercion becomes opt-in in 0.9 (ADR-0009) |

Having the Layer 0 proxy before the corpus is not a loss: it is what makes
the collectors in Phase 2 cheap, and the hosted tier in Phase 3 is a
deployment question, not a build. The order below is about where effort
goes from now.

## Phases

### Phase 0, weeks 1 to 3: seed from history

Deliverables

- The transcript audit becomes a one-command personal report:
  `sayagain audit` reads Claude Code, Cursor and Codex transcripts (the
  0.6 analysis over transcript rows, not only ledger rows), prints the one
  page from `docs/measurement.md` section 6, and writes a shareable
  screenshot-ready HTML page. The `scripts/baseline` analyzer is folded in.
- Opt-in shape contribution: `sayagain contribute` builds the payload in
  ADR-0009, shows it in full, asks, sends. Nothing leaves without a `y`.
  The endpoint and its owner are decided later (ADR-0009, decision 3);
  until then the command writes the document locally and stops.
- The linter runs over the full public registry (`sayagain lint --registry`
  or a script) and produces M16 and the grade distribution with the
  rule-set version.
- Baseline on our own agents: this repository's history, quantbot, the
  delivery flywheel; the three reports kept out of the repository.

Status, 2026-09-05 (0.10.0): `sayagain audit` and `sayagain contribute`
shipped (Claude Code, Codex and Cursor readers; the HTML page; the shape
document, consent flow and weekly setting; `docs/CONTRIBUTING-DATA.md`).
The `scripts/baseline` script stays as the pre-registered instrument rather
than being folded in. 0.11.0 added `sayagain lint --registry` (the M16
scan; a seeded sample of the servers with a Streamable HTTP remote is the
first published number, the full scan of about 15,000 remotes stays the
target and runs as a background job) and `sayagain audit --project` for
the per-agent baselines; the first scan and two baselines are in
`docs/registry-scan.md`. The delivery flywheel has no transcripts on the
build machine yet.

Metric that proves it worked

- One command from a fresh clone to a report on each of the three agents.
- The registry scan published as a number: share of registry tools without
  documented parameter constraints (M16), with the rule-set version.
- At least three consented contributions received by the index endpoint.

Explicitly not built

- No proxy feature work beyond fixes. No new UI screens. No hosted tier.
- No paid acquisition. No collection of anything but the shape schema.

### Phase 1, weeks 3 to 6: the public artefact

Deliverables

- The Tool Reliability Index, public: per public MCP tool, a static score
  from the linter over the registry, and where contributed shapes exist, a
  runtime score with failure rate, dominant error class, per-model-family
  behaviour, the resolution that worked, and a description-rewrite
  suggestion. A README badge per tool, a link per server.
- A data post with the headline numbers: registry share without parameter
  constraints; mis-call rate (M19) and calls to recover (M17) across the
  contributed sessions.
- Direct outreach to the top hundred server maintainers with their score
  and two fixes each.
- The convention published: `sh.sayagain/intent` and the `_meta` keys
  (spec v0.1.x), idempotency and compensation annotations, and the SEP
  draft. Compensation declarations become a linter rule.

Status, 2026-09-05 (0.12.0): the index builds as a static site
(`sayagain index build`, ADR-0010) with a page and a badge per server, a
badge per tool and `index.json`; `sayagain index fixes <server>` writes the
outreach message; the `Index` workflow scans and builds on demand and
publishes to GitHub Pages once the owner sets `SAYAGAIN_INDEX_PAGES`
(decision 3 stays open, so nothing is public yet). The convention is spec
v0.1.7 (tool declarations: idempotency, compensation) with the SEP draft
in `docs/sep-draft.md` and `annotations/compensation` in the linter. The
data post is drafted in `docs/data-post.md`. Outreach itself, the runtime
scores' first real data, and the public URL wait on the owner.

Metric that proves it worked

- Index live with a static score for every registry tool and a runtime
  score for at least one contributed corpus.
- Outreach: replies and fixes landed, tracked per maintainer.
- The SEP draft filed; the convention referenced by at least one server
  other than ours.

Explicitly not built

- No runtime scores from our own proxy traffic without a contribution
  (the daemon never phones home). No per-tenant dashboards.
- No plan auditing, no units: the index scores tools, not plans.

### Phase 2, weeks 6 to 10: zero-install collectors

Deliverables

- A Claude Code `PostToolUse` hook that records shapes locally and offers
  contribution through the same consent flow.
- LiteLLM and ContextForge plugins that do the same where traffic already
  flows through them.
- The monthly data report cadence starts (the Phase 1 post, repeated).

Metric that proves it worked

- Sessions contributed per month, and the share of shapes arriving from
  collectors rather than from history.
- The second data post published on schedule.

Explicitly not built

- No new gateway, no proxying of model traffic. The collectors observe;
  the boundary stays an MCP proxy.

### Phase 3, weeks 10 to 16: Layer 0 in production, hosted tier opens

Deliverables

- What 0.1 to 0.7 already provide, made deployable: a Postgres dead-letter
  and ledger store beside SQLite, hold-before-write policy in the registry
  file, the replay screen, and the community edition defaults: hold
  control, dead-letter queue, linter, intent verification with a
  bring-your-own side model, a local ledger retained thirty days.
- The hosted tier: a generous free allowance to grow the corpus, priced in
  protected tools plus decisions, pass-through calls free. Autonomy ladder:
  interactive free, unattended paid, destructive-capable enterprise.

Metric that proves it worked

- M15 (retries avoided, repairs, holds, replays) reported across hosted
  traffic; M9 unacknowledged writes at zero on wrapped servers.
- Overhead p99 under 25 ms locally (met in 0.4) and measured over the
  network.
- Hosted: protected tools and decisions per month; free-to-paid conversion
  at the unattended step.

Explicitly not built

- No desktop shell. No token-saving pitch anywhere but the trial page.
- Nothing that edits arguments before a failure (ADR-0009).

### Phase 4, months 4 to 6: Layer 1, units of commitment, plan auditing

Deliverables

- Intent verification with a side model within a budget, reroute, side-model
  repair, intent-drift detection. Gate before building: H5 holds in the
  fill-rate experiment (`docs/measurement.md` section 5.3) and the drift
  base rate M14 is measured.
- Units of commitment: the agent declares a sequence (steps, data flow,
  intent, expected end state); the boundary executes it as one unit,
  intermediate results never round-tripping through the model, per-step
  retry, hold and deterministic repair, and on failure past budget it
  compensates committed steps and dead-letters the whole unit with intent
  attached. Cross-model by construction. The boundary never edits a unit:
  it executes, holds, or rejects with a diagnosis.
- Plan auditing, shipping with units: static checks before execution,
  data-flow type-check against `outputSchema`, every destructive step with
  a declared compensation, blast-radius sum within policy, intent-versus-plan
  divergence, steps touching badly-scored tools. Verdict accept, hold or
  reject with a diagnosis, from the same rule engine as the linter.
- Reliability-index pre-flight warnings in the daemon.

Metric that proves it worked

- H5 and M14 as gated. Share of multi-step tasks executed as units;
  compensation success rate; the rate at which operators uphold hold and
  reject verdicts from plan auditing (a verdict overridden most of the time
  is a bad rule).

Explicitly not built

- No automatic plan edits. No reordering, no step removal, no argument
  change without a hold. A warning stays a warning.
- No managed side model yet: bring your own.

### Phase 5, months 6 to 9: enterprise

Deliverables

- Policy engine and approvals UI, dry run in the approval flow (read-only
  steps run, write steps simulated from declared postconditions; validates
  structure and policy, not external state, and says so), audit-pack
  export, retention beyond thirty days, SSO, SCIM, RBAC, self-host
  licence, the "a held call never executes twice" SLA.
- The decision, with two gateway maintainers and the numbers: plugin,
  partnership, or standalone.

Metric that proves it worked

- Two design partners in production. The SLA evidenced by the M9 audit
  across their traffic. Audit-pack exports used in a real review.

Explicitly not built

- No custom identity: SSO through the standards. No general observability
  product; the ledger exports to what customers already run.

## Independent of the phases

- Onboarding (0.14.0, ADR-0012): `sayagain doctor` and `sayagain classes`
  make the boundary explain its own setup, because the three things that went
  wrong on the author's machine (a server calling past the proxy, a stdio
  server started outside its project, a design server whose annotations put
  screenshots behind an approval) were all invisible until someone read the
  ledger by hand. The numbers it moves: the share of host-configured servers
  whose calls reach the boundary, and the count of doctor errors and warnings
  on a first run.
- The proof, second half (docs/measurement.md 5.6, 0.16.0): the
  fault-injection harness buys the independence the organic A/B cannot wait
  for, by making every task its own cluster. It is the internally valid half;
  5.4 is the externally valid half; the whitepaper needs both and should say
  which claim rests on which.
- The proof (docs/measurement.md 5.4): `serve --arm coinflip` and
  `report --ab` run the pre-registered A/B on the operator's own agents:
  a control arm that observes only, against the boundary as shipped
  (0.13.0, ADR-0011). The domain purchase and the whitepaper launch (5.5)
  wait on its verdict.

The whitepaper can ship any time after the registry scan. The desktop
shell (the former 0.10) is deferred until a phase needs it; the page served
by the daemon covers the operator today.

## What no phase does

- Change the arguments of a write without a hold.
- Change any argument before a failure without the operator having opted
  that coercion in (ADR-0009: one switch per intervention).
- Send anything but the contributed-shape schema, and never without consent.
- Ship a feature without the metric that would show it working.
