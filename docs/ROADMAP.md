# Roadmap

Backend first, then the surfaces a person touches, then the desktop shell.
Every minor version is one slice that a user can run; every slice has an
exit gate from `docs/measurement.md` so the version number means something.
Patch versions are fixes. 1.0 waits for evidence, not for features.

| Version | Slice | What a user can do | Exit gate |
| ------- | ----- | ------------------ | --------- |
| 0.1.0 | `wrap` | `sayagain wrap -- <server>` puts the boundary around one stdio server: identity untouched, a receipt and status on every result, the boundary announced on `initialize`, a JSONL ledger, `sayagain ledger` to read it. | Runs under Claude Code against a real server for a week with zero behaviour change in the baseline analyzer. |
| 0.2.0 | Classify, dedupe, hold | Tool classes from annotations and overrides; DISREGARD on duplicate keys or fingerprints; STANDBY for destructive tools with a held notice; `sayagain holds`, `approve`, `reject`; SQLite ledger. | M8 duplicates reach zero on wrapped servers; first held call approved end to end. |
| 0.3.0 | Retry, repair, dead-letter | Bounded backoff for retryable failures on safe tools; deterministic coercion with `sh.sayagain/repair`; the repair budget; UNABLE with `sayagain replay`; error rewriting. | M15a retries avoided measurable on own agents; no write ever executed twice (M9 audit). |
| 0.4.0 | Daemon and HTTP | `sayagain serve`, one route per upstream, `sayagain stdio <name>` shim with auto-start, `add`, loopback token, Streamable HTTP upstreams. | Two hosts share one daemon; p99 overhead under 25 ms locally (H6). |
| 0.5.0 | Onboarding | `import --rewrite` for Claude Code, Cursor, Claude Desktop, VS Code; `install`; `eject`; backups. | A fresh machine goes from nothing to every server wrapped in one command, and back. |
| 0.6.0 | Observability | OTLP spans, signatures and rankings from the ledger, `tools`, `errors`, `report --weekly`; `@sayagain/lint` CLI and GitHub Action; analyzer reads tap logs. | Weekly report produced from the ledger alone; registry scan published (M16). |
| 0.7.0 | Web UI | Served by the daemon: holds inbox with SSE first, then tool health, ledger, learn, servers, settings. `sayagain ui`. | A held write is approved from the inbox in under ten seconds from notification. |
| 0.8.0 | Learning loop | Learned coercions, description augmentation, error rewrite with last fix, lift measurement, automatic revert, upstream report. | M21 shows lift on at least one tool in own traffic; one revert observed. |
| 0.9.0 | Layer 1 | Schema shim, task-intent header, verification against intent, drift detection, side-model repair within budget. | H5 holds in the fill-rate experiment; drift base rate (M14) measured. |
| 0.10.0 | Desktop shell | Tauri app embedding the daemon's UI: tray count of held calls, notifications, launch at login, keychain, daemon supervision. Ships through `desktop.yml` the way Docent does. | Installed from a GitHub Release on macOS, Linux and Windows without a terminal. |
| 1.0.0 | Stable | Spec frozen at 1.0, SEP submitted, A/B evidence for H6 published in the README. | Two weeks or 2,000 calls per arm with a confidence interval that excludes zero. |

Independent of the row order: the whitepaper and the registry scan can ship
any time after 0.3, and the hosted tier decision is made after 0.6 when the
telemetry schema has real traffic behind it.

## What each version must not do

- 0.1 to 0.3 never change the arguments of a write call without a hold.
- Nothing before 0.9 depends on the model stating intent.
- No version ships a feature without the metric that would show it working.
