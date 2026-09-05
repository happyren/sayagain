# Say Again?

**The commitment boundary for agent tool calls.**

A tool call is the only message in the modern stack that crosses a trust
boundary with no acknowledgement, no transaction, no dead-letter queue and no
replay. The agent that sent it is the worst party to handle its failure.
Say Again sits between MCP clients and MCP servers and owns that boundary: it
acknowledges every call, holds the ones that must not run twice, repairs the
ones that can be repaired, dead-letters the rest, and lets an operator replay
any of them with the agent's original intent attached.

The name is a radio procedure word. On a voice net nobody says "repeat"; the
receiver says "say again" and the sender re-transmits. Say Again is the
operator between the agent and its tools who says it, so the agent never has
to.

> **Status: pre-alpha.** The `_meta` convention, design records and package
> skeletons are here. The proxy runs (0.5: `wrap`, the daemon, holds, repair,
> dead letters, one-command onboarding). Watch the repo or open a
> Discussion.

## What it does

Every `tools/call` that passes through Say Again becomes a message with four
properties:

1. **Carries intent** alongside the precise call
   (`params._meta["sh.sayagain/intent"]`).
2. **Acknowledged.** The agent can tell *accepted* from *executed*.
3. **Held, not retried**, when the tool is not provably idempotent.
4. **Replayable** by an operator, with the original intent attached.

**Layer 0, zero-touch (any MCP client):** bounded backoff retry, holds for
destructive tools and for writes with an unknown outcome, deterministic
argument repair from the tool's own schema, dead-letter and replay, and
error rewriting into model-actionable feedback. The ledger is a JSONL file
today; the daemon adds persisted holds and an optional SQLite store.

**Layer 1, opt-in:** intent capture, intent verification and reroute, bounded
side-model repair, intent-drift detection, and hold-before-write with
approval.

## Getting started

Today, 0.5: one command wraps every server your hosts know about, and one
command puts it back (see `docs/ROADMAP.md` for what follows).

```bash
npm install -g @sayagain/proxy       # Node 22.13+; provides the `sayagain` command (or: npx -y -p @sayagain/proxy sayagain ...)

sayagain hosts                       # what Claude Code, Cursor, Claude Desktop and VS Code have configured
sayagain import --host all --rewrite # register every server and point each host at Say Again (backups beside the files)
sayagain eject --host all            # and back

# Or by hand: register upstreams, start the daemon, point hosts at it.
sayagain add notion -- npx -y @notionhq/notion-mcp-server
sayagain add linear --url https://mcp.linear.app/mcp --header 'Authorization=Bearer ${LINEAR_TOKEN}'   # single quotes: resolved by the daemon, never stored
sayagain serve --detach              # http://127.0.0.1:7777/mcp/<name>; bearer token in ~/.sayagain/token
sayagain status                      # SAYAGAIN_HOME=<dir> moves every file the tool keeps

# Host entry, keeping the key the host already uses (what --rewrite writes; the launcher is
# refreshed by every command, so the entry survives Node.js and package upgrades):
#   "notion": { "command": "~/.sayagain/bin/sayagain", "args": ["stdio", "notion"] }
# or, for hosts that speak Streamable HTTP (--transport http):
#   "notion": { "type": "http", "url": "http://127.0.0.1:7777/mcp/notion",
#               "headers": { "Authorization": "Bearer <token>" } }

# Or wrap one stdio server in place, no daemon:
sayagain wrap -- npx -y @notionhq/notion-mcp-server
```

Once calls flow, the ledger answers the Databricks questions ("which tool
errors recur most, how many calls does recovery take") for your own tools:

```bash
sayagain tools --since 7d            # ranked by the waste their failures cause
sayagain errors create_page          # signatures, recovery paths, shape changes, suggestions
sayagain report                      # the weekly page from docs/measurement.md
sayagain lint --all                  # grade every registered server's tool definitions
sayagain serve --otlp http://127.0.0.1:4318/v1/traces   # or OTEL_EXPORTER_OTLP_ENDPOINT; a local collector on :4318 is found by itself (SAYAGAIN_OTLP=off never exports)
```

Options: `--hold destructive|always|never`, `--hold-wait <ms>`,
`--class <tool>=<class>`, `--dedupe-window <ms>`, `--retry <n>`,
`--no-repair`, `--no-rewrite-errors`, `--no-announce`, `--ledger <path>`,
`--deadletter <path>`. A write that fails with an unknown outcome, or whose
arguments were repaired, waits for your approval before it is sent again.

### What the agent sees

| Surface | With Say Again in the path |
| ------- | -------------------------- |
| Server name and key | Unchanged |
| Tool names, descriptions, schemas | Unchanged (optional intent property on write tools, off by default) |
| Resources, prompts, notifications | Relayed |
| Every result | Plus `_meta` receipt and status |
| Held write | A text block saying it is held, with the receipt |
| `initialize` | Plus `_meta["sh.sayagain/boundary"]` and one sentence of instructions |

## Prowords

The specification uses plain words for `sh.sayagain/status`. The console and
the logs use the radio ones, because they are shorter and everyone who has
heard them knows exactly what they mean.

| Status          | Proword      | On the net it means                                  |
| --------------- | ------------ | ---------------------------------------------------- |
| `queued`        | ROGER        | Received. Will act. Not yet done.                    |
| `executed`      | WILCO        | Received, understood, complied.                      |
| `repaired`      | CORRECTION   | Complied, after fixing what you sent. On the record. |
| `held`          | STANDBY      | Wait for clearance.                                  |
| `deduplicated`  | DISREGARD    | Your last transmission repeated an earlier one.      |
| `dead-lettered` | UNABLE       | Cannot comply. Retries exhausted; kept for review.   |
| verification    | READ BACK    | The call is read back against the stated intent.     |
| repair request  | SAY AGAIN    | The model is asked for a corrected call.             |

## What it is not

- Not a gateway. Authn, authz and rate limits belong to your gateway;
  Say Again runs behind it.
- Not DLP. Run your redaction or classifier in the pre-call hook.
- Not an LLM router.

Gateways decide who may call. DLP decides what may leave. Say Again decides
whether what the agent did is what it meant, and holds it when it isn't.

## Packages

| Package            | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `@sayagain/sdk`    | Spec constants, types and client helpers for intent metadata |
| `@sayagain/proxy`  | The MCP proxy (Layer 0 and Layer 1)                        |
| `@sayagain/lint`   | Linter for MCP tool definitions                            |

## Specification

[`spec/intent-metadata.md`](spec/intent-metadata.md) defines the
`sh.sayagain/*` metadata convention for MCP `tools/call` requests and
results. It is written to be implementable by any proxy or gateway, not only
this one.

## Design records

Decisions live in [`docs/adr/`](docs/adr/). Start with
[ADR-0003](docs/adr/0003-intent-transport.md) (how intent travels) and
[ADR-0004](docs/adr/0004-hold-by-default.md) (why held calls are never
blindly re-executed).

## Development

```bash
corepack enable pnpm
pnpm install
pnpm check      # lint, typecheck, test
```

Node 22 or newer.

## Contributing and license

Apache-2.0. Contributions require a DCO sign-off (`git commit -s`). See
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[GOVERNANCE.md](GOVERNANCE.md) and [TRADEMARK.md](TRADEMARK.md).
