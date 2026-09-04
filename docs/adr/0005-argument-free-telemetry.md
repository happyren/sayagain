# ADR-0005: Shared telemetry never carries arguments or content

- Status: Accepted
- Date: 2026-09-04

## Context

The enterprise pitch is "the ledger stays in your network." The data moat is
"a cross-tenant corpus of which tools fail how, and what fixed them." These
conflict unless the shareable part of the corpus is designed to exclude
anything a customer would refuse to share.

## Decision

- Two stores. The **ledger** holds full calls, arguments, results, intent,
  repairs and replays, and lives in the operator's trust domain.
- **Telemetry** is a separate, opt-in stream containing only: server
  identity (name and version), tool name, argument key names and JSON
  types (never values), error class, repair kind and rule, outcome, hold
  reason, token and latency deltas, and model family. No argument values,
  no content, no intent text, no task text.
- The schema is published in `docs/telemetry.md` before the hosted tier
  launches, and the proxy ships with telemetry off. The hosted tier may make
  it a condition of the free plan.

## Consequences

- Per-tool failure patterns and description-rewrite suggestions can be built
  from telemetry alone.
- Semantic repair patterns that need argument values stay per-tenant.
- Consent is a one-line config change, which is the only kind that scales.
