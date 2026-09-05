# Contributing data to the Tool Reliability Index

Terms version **2026-09-05**. `sayagain contribute --accept-terms 2026-09-05`
refers to this document. A later version of these terms gets a new date, and
`contribute` asks again before it sends anything under it.

## What a contribution is

One JSON document with the schema `sayagain.shape/1`, built on your machine
by `sayagain contribute` from your own ledger or transcripts, written to
`~/.sayagain/contributions/<timestamp>.json` before anything else, printed in
full, and sent only after you answer `y` (or pass `--yes`). The document is
the whole list of what leaves your machine; there is no second channel.

Per public MCP tool it carries:

| Field | Content |
| ----- | ------- |
| `server`, `tool` | The server's name from `initialize` (ledger) or the name your host's configuration gives the server (transcripts), lowercased; and the tool's name. A server named by an opaque id is left out (below). `serverVersion` is reserved and not filled in yet. |
| `schemaHash` | SHA-256 of the tool's input schema, first 16 hex digits. Present when the source carried the schema (Codex rollouts today). |
| `toolClass` | `read-only`, `idempotent-write`, `write`, `destructive`: from the tool's annotations, else from the verb in its name. |
| `modelFamily` | `claude`, `gpt`, `gemini`, `open-weight`, `unknown`. Coarse by construction; always `unknown` from the ledger, which does not see the model. |
| `intentCategory` | `read`, `search`, `create`, `update`, `delete`, `execute`, `unknown`, derived from the tool's name and class. Never from intent text. |
| `calls`, `failures`, `unacknowledgedWrites`, `duplicateWrites` | Counts (M1, M8, M9 in `measurement.md`). |
| `errors[].class` | `coercible`, `retryable`, `semantic`, `blocked`, `other`. |
| `errors[].signatureHash` | 64 bits of SHA-256 of the masked error signature. The masked text stays in your local ledger. |
| `errors[].argShape` | Sorted `key:type` entries of the most common failing call. Keys and JSON types, never values. |
| `errors[].resolution` | `type-change`, `added-key`, `removed-key`, `other-tool-first`, `retry-same`, `none`. |
| `errors[].shapeChange`, `errors[].recoveryPath` | The change in keys or types that fixed it; the tools called before recovery. |
| `errors[].callsToRecover`, `errors[].boundary` | Counts (M17, M15). |

Plus the envelope: a `contributor` id, the `consent` record (terms version,
time of acceptance), the client name, version and source, the window, and
the number of sessions.

## What is never in it

Argument values, tool results, prompts, intent text, task text, file paths,
URLs, error message text, session ids, hostnames, user names, project
names, API keys. A server whose name is an opaque id (a UUID, a long hex
string: a private connector rather than a public server) is left out of
the document altogether. The builder never reads argument values (rows carry shapes
and hashes only), and `assertShapeDocumentSafe` refuses any document with a
field outside the list above, a name containing a path or whitespace, a hash
that is not hex, or a shape entry that is not `key:type`. If a future change
to the builder adds a field, that check fails until this document changes.

## The contributor id

`c_` followed by 16 hex digits, made at random on your machine on first use
and kept in `~/.sayagain/config.json`. It carries no identity. It exists so
you can withdraw: `sayagain contribute --forget` asks the index to delete
everything filed under the id, then rotates it locally. The index keeps no
other key to your contributions.

## Sending

- `sayagain contribute` sends nothing by default. It writes the document,
  prints it in full (pipe it through a pager when long), prints a one-line
  summary, and asks. Non-interactive runs need `--yes`. The first
  contribution from a machine also needs `--accept-terms 2026-09-05`.
  `--json` prints the document alone and never sends.
- The endpoint is the one you name with `--endpoint <https url>` (kept in
  `config.json`). Until the Tool Reliability Index has a public endpoint
  (ADR-0009, decision 3, pending), there is none, and the command stops
  after writing the file.
- Only HTTPS leaves the machine. Plain HTTP is accepted for a loopback
  endpoint, for tests.
- `sayagain contribute --weekly on` lets the running daemon send one
  document a week from the ledger under the terms you accepted, with the
  same endpoint. `--weekly off`, `--forget` and `SAYAGAIN_CONTRIBUTE=0` all
  stop it. The daemon never sends without that setting.

## Wire contract (draft, until the endpoint exists)

- `POST <endpoint>` with the document as JSON, `Authorization: Bearer <contributor>`,
  `User-Agent: sayagain/<version>`. Reply `2xx` with `{ "receipt": "...", "url": "..." }`;
  `url` points at the contributor's servers on the index.
- `DELETE <endpoint>` with the same bearer deletes everything filed under the
  contributor id. Reply `2xx`.

## Retention and use

The index keeps contributions to compute per-tool runtime scores: failure
rate, dominant error class, behaviour per model family, the resolution that
worked, and a description-rewrite suggestion. Aggregates are public. Raw
documents are kept for the life of the contributor id, deleted on `--forget`,
and never sold or shared as individual documents. Where the index is hosted,
who operates it, and its data-protection register entry are decided in
ADR-0009 decision 3; this section is updated when they are.

## Your copy

Every document you offered, sent or not, stays in
`~/.sayagain/contributions/` with owner-only permissions. Delete them at
will; the index never reads that directory.
