# Architecture Decision Records

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](0001-license-and-contribution-model.md) | Apache-2.0 everywhere, DCO, enterprise code in a separate repo | Accepted |
| [0002](0002-typescript-pnpm-monorepo.md) | TypeScript, pnpm workspaces, single repo | Accepted |
| [0003](0003-intent-transport.md) | Intent travels in `_meta`, captured by a schema shim for zero-touch hosts, anchored by out-of-band task intent | Accepted |
| [0004](0004-hold-by-default.md) | Non-idempotent calls are held, never blindly re-executed | Accepted |
| [0005](0005-argument-free-telemetry.md) | Shared telemetry never carries arguments or content | Accepted |
| [0006](0006-onboarding-and-transparency.md) | One virtual server per upstream, one-command onboarding, identity preserved end to end | Accepted |
| [0007](0007-observability-and-learning-loop.md) | Per-call spans, error signatures, mis-call ranking, and measured interventions that improve the next call | Accepted |
| [0008](0008-web-ui.md) | The web UI is served by the daemon: no framework, no build step, one origin and one token | Accepted |
| [0009](0009-tool-reliability-index-and-contribution.md) | The Tool Reliability Index, the contributed-shape schema, the consent flow, and the scope guard applied to 0.1 to 0.8 | Accepted |
| [0010](0010-index-as-a-static-artefact.md) | The index is a static artefact built from the scan and the contributions; hosting is a repository variable | Accepted |
| [0011](0011-the-ab-protocol-inside-the-boundary.md) | The A/B protocol runs inside the boundary, with a control arm that observes only | Accepted |
| [0012](0012-the-boundary-explains-its-own-setup.md) | The boundary explains its own setup, and proposes classes it will not apply on its own | Accepted |

Template: [0000-template.md](0000-template.md).
