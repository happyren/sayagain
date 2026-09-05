# ADR-0009: The Tool Reliability Index, the contributed-shape schema, and the scope guard

- Status: Accepted
- Date: 2026-09-05

## Context

The roadmap adjustment of 2026-09-05 adds a public artefact, the Tool
Reliability Index: per public MCP tool, a static score from the linter over
the registry and a runtime score from shapes contributed by users. It also
states the scope guard: every feature returns a verdict; none acts on its
own. Three things follow that need a record: what a contributed shape is,
exactly; how consent works; and which parts of 0.1 to 0.8 the guard sends
back.

## Decision

### The contributed shape

A contribution is one JSON document. Its fields are the whole list; nothing
else is sent, and the client shows the document in full before sending.

```json
{
  "schema": "sayagain.shape/1",
  "contributor": "c_9f2a4c7e1b3d5a60",
  "consent": { "termsVersion": "2026-09-05", "acceptedAt": "2026-09-05T10:12:00Z" },
  "client": { "name": "sayagain", "version": "0.9.0", "source": "claude-code-transcripts" },
  "window": { "since": "2026-08-01T00:00:00Z", "until": "2026-09-05T00:00:00Z" },
  "sessions": 117,
  "shapes": [
    {
      "server": "notion",
      "serverVersion": "1.4.2",
      "tool": "create_page",
      "schemaHash": "5b1e0c9a7d3e2f41",
      "toolClass": "write",
      "modelFamily": "claude",
      "intentCategory": "create",
      "calls": 120,
      "failures": 7,
      "unacknowledgedWrites": 1,
      "duplicateWrites": 2,
      "errors": [
        {
          "class": "coercible",
          "signatureHash": "a41c0d9e7b2f5c63",
          "count": 5,
          "argShape": ["parent:string", "properties:object", "limit:string"],
          "resolution": "type-change",
          "shapeChange": "changed limit:string->number",
          "recoveryPath": ["get_page"],
          "callsToRecover": { "median": 1, "unrecovered": 1 },
          "boundary": { "repaired": 3, "held": 0, "deadLettered": 1 }
        }
      ]
    }
  ]
}
```

Field by field:

| Field | Content | Why it is safe |
| ----- | ------- | -------------- |
| `contributor` | A random id made on the machine, rotatable, deletable | Lets a contributor withdraw their data; carries no identity |
| `consent` | The terms version accepted and when | The record of the `y` |
| `client.source` | `claude-code-transcripts`, `cursor-transcripts`, `codex-transcripts`, `ledger`, `claude-code-hook`, `litellm`, `contextforge` | Which collector produced it; the index weights sources |
| `server`, `serverVersion` | The name from `initialize` (or the transcript's server prefix), lowercased | Public identifiers of public servers |
| `tool` | The tool name | Same |
| `schemaHash` | SHA-256 of the canonical `inputSchema`, first 16 hex | Distinguishes tool versions; the schema itself is public |
| `toolClass` | From annotations, as the sdk classifies | Public |
| `modelFamily` | `claude`, `gpt`, `gemini`, `open-weight`, `unknown` | Coarse by construction |
| `intentCategory` | `read`, `search`, `create`, `update`, `delete`, `execute`, `unknown`, derived from the tool class and name, never from intent text | Text stays home |
| `calls`, `failures`, `unacknowledgedWrites`, `duplicateWrites` | Counts (M1, M8, M9) | Counts |
| `errors[].class` | `coercible`, `retryable`, `semantic`, `blocked`, `other` | An enum |
| `errors[].signatureHash` | 64 bits of SHA-256 of the masked signature | A grouping key: the masked text stays home |
| `errors[].argShape` | Sorted `key:type` entries of the failing call | Keys and JSON types, never values |
| `errors[].resolution` | `type-change`, `added-key`, `removed-key`, `other-tool-first`, `retry-same`, `none` | An enum |
| `errors[].shapeChange`, `recoveryPath` | The change in keys or types; the tools called before recovery | Names and types |
| `errors[].callsToRecover`, `boundary` | Counts (M17, M15) | Counts |

Never present: argument values, results, prompts, intent text, task text,
file paths, URLs, error message text, session ids, hostnames, user names.
The masked error signature itself stays in the local ledger; only its hash
travels, and the index treats the hash as a key, not as a secret.

### Consent

`sayagain contribute` is the only path, and it is manual by default.

1. Build the document locally from the ledger or the transcripts, and write
   it to `~/.sayagain/contributions/<timestamp>.json` before anything else,
   so the contributor keeps a copy of exactly what was offered.
2. Print it in full (paged when long), then a one-line summary: servers,
   tools, shapes, window, source.
3. Ask `Send this to the Tool Reliability Index? [y/N]`. Non-interactive
   runs need `--yes`, and the first contribution from a machine also needs
   `--accept-terms <version>`; the acceptance is recorded in `config.json`
   with the terms version, and the document carries it.
4. Send it to the index endpoint over HTTPS with the contributor id. The
   reply is a receipt and a link to the contributor's servers on the index.
5. Recurring contribution exists only as an explicit setting,
   `sayagain contribute --weekly on`, which the daemon honours by running
   steps 1 and 4 with the last accepted terms, and which the page shows
   as on. `--weekly off`, `sayagain contribute --forget` (deletes the
   contributor's data on the index and rotates the id), and
   `SAYAGAIN_CONTRIBUTE=0` all stop it. The daemon never sends anything
   without that setting.
6. `docs/CONTRIBUTING-DATA.md` states the schema, the retention, the
   deletion path, and the terms, and is the document `--accept-terms`
   refers to.

### The scope guard, applied to 0.1 to 0.8

| Feature | Verdict | Decision |
| ------- | ------- | -------- |
| Hold before a destructive call (0.2) | A hold is a verdict to the operator | Keep |
| Dedupe on idempotency key or write fingerprint (0.2) | A verdict to the agent (`deduplicated`, with the first result) | Keep |
| Bounded retry on safe tools (0.3) | Retry is Phase 3 scope; the call is unchanged | Keep |
| Deterministic repair after a failure (0.3) | Repair is Phase 3 scope; a write's repaired arguments wait behind a hold; the agent sees `repaired` and the change | Keep |
| Error rewriting with guidance (0.3) and the learned hint (0.8) | A diagnosis returned to the agent | Keep |
| Description augmentation (0.8) | A fact returned to the agent inside the tool list, delimited and attributed; the upstream's text is untouched | Keep, and keep the delimiter and the cap |
| Learned coercion applied after a failure (0.8) | A repair, as above | Keep |
| **Learned coercion applied before a read-only call leaves (0.8)** | The boundary changes a call the agent made before anything failed and without the agent knowing why: a plan edit in miniature | **Send back: off by default. The rule stays derived and shown; applying it before a call leaves requires the operator to opt that intervention in (`sayagain learn --apply <id>`, one switch per coercion), and the agent still sees `repaired` with the change** |
| Automatic revert of an intervention (0.8) | The boundary changing its own behaviour, not the plan | Keep |
| `import --rewrite` of host configs (0.5) | An operator action with a backup | Keep |
| The learning pass itself (0.8) | Produces verdicts and records | Keep |

Two more places where wording, not code, drifts from the pitch:

- Until 0.9, `docs/measurement.md` named the failure tax in dollars as the
  first north-star number and `sayagain report` printed it first (both
  reordered in 0.9, decision 2 below). The pitch is
  intent versus action at the boundary; token and dollar savings are a
  dashboard metric and a trial justification. The unacknowledged-write rate
  (M9) and, once Layer 1 exists, the intent-versus-action rate lead; the
  failure tax follows. Both stay measured.
- The community edition keeps a thirty-day local ledger. The ledger has no
  retention today; a default of thirty days with `--retain <days>` is a
  Phase 3 item, and retention beyond it is a paid gate rather than a
  removed feature.

## Decisions taken on 2026-09-05

1. Pre-send learned coercion is opt-in per intervention. Interventions carry
   a mode: `advise` (the default: the hint in the description, the repair
   after a failure) or `apply` (also before a read-only call leaves), set
   by the operator with `sayagain learn --apply <id>` or from the page.
2. The north star reorders: the unacknowledged-write rate (M9) leads, the
   failure tax follows, and the intent-versus-action rate joins the first
   when Layer 1 exists. `docs/measurement.md` carries the dated amendment.
3. The index endpoint, its hosting and the owner of the data policy are
   postponed. `sayagain contribute` ships writing the document locally and
   sending only to an endpoint given with `--endpoint` or in `config.json`;
   until one exists it says so and stops after the file.

## Alternatives considered

- **Collect from proxy traffic by default.** Faster corpus, incompatible
  with the trust-domain position and with ADR-0005. Rejected.
- **Send masked signatures as text.** Better grouping across contributors,
  but masked text can still carry fragments a contributor did not mean to
  share. The hash groups well enough; the index can ask a contributor to
  reveal a signature in the consent flow later.
- **Keep pre-send learned coercion on by default.** It is measurably useful
  (0.8's smoke showed a call fixed before it left), but it is the boundary
  deciding what the agent meant. Opt-in keeps the benefit for operators who
  want it and keeps the position.

## Consequences

- 0.9 carries the switch: pre-send coercion becomes opt-in per
  intervention; `learn` grows `--apply` and `--advise`; the Learn screen
  shows which mode each intervention is in; the ledger row already records
  the rule, so the change is auditable.
- `sayagain contribute` and `sayagain audit` are Phase 0 deliverables; the
  index endpoint and its data policy are Phase 1.
- 0.10 ships both. Details settled in the code: `schemaHash` is optional,
  present when the source carried the schema (Codex rollouts list tool
  schemas; Claude Code transcripts and the ledger do not yet);
  `serverVersion` is reserved and never filled in; a server named by an
  opaque id (UUID, long hex) is a private connector and is left out;
  transcript rows carry two error classes the boundary never writes,
  `interrupt` and `no-result`, which count as unknown outcomes (M9) and not
  as failures (M1). Two departures from the consent flow above: the
  document is printed unpaged (pipe it), and the operator page does not
  yet show the weekly switch (`sayagain contribute --status` does). The
  wire contract for the endpoint is a draft in `docs/CONTRIBUTING-DATA.md`
  until decision 3 is taken.
- `docs/telemetry.md` (ADR-0005) is superseded by the shape schema above
  for anything that leaves the machine; the OTLP export (0.6) is the
  operator's own collector and is unaffected.
