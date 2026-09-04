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
> skeletons are here. The proxy is not yet usable. Watch the repo or open a
> Discussion.

## What it does

Every `tools/call` that passes through Say Again becomes a message with four
properties:

1. **Carries intent** alongside the precise call
   (`params._meta["sh.sayagain/intent"]`).
2. **Acknowledged.** The agent can tell *accepted* from *executed*.
3. **Held, not retried**, when the tool is not provably idempotent.
4. **Replayable** by an operator, with the original intent attached.

**Layer 0, zero-touch (any MCP client):** queue, bounded backoff retry,
dead-letter queue (SQLite by default, Postgres for shared deployments),
deterministic argument coercion, and error rewriting into model-actionable
feedback.

**Layer 1, opt-in:** intent capture, intent verification and reroute, bounded
side-model repair, intent-drift detection, and hold-before-write with
approval.

## Getting started

Today, 0.2: one server, wrapped in place. The daemon, HTTP routes and
`import --rewrite` arrive in 0.4 and 0.5 (see `docs/ROADMAP.md`).

```bash
# Wrap a stdio server. Its name, tools and errors are untouched; every result
# gains a receipt; destructive tools are held until you approve.
npx sayagain wrap -- npx -y @notionhq/notion-mcp-server

# In your host config, keep the key and wrap the command:
#   "notion": { "command": "npx", "args": ["sayagain", "wrap", "--", "npx", "-y", "@notionhq/notion-mcp-server"] }

sayagain holds                 # what is waiting
sayagain approve <receipt>     # or: sayagain reject <receipt>
sayagain ledger --tail 20      # what happened
```

Options: `--hold destructive|always|never`, `--hold-wait <ms>`,
`--class <tool>=<class>`, `--dedupe-window <ms>`, `--no-announce`,
`--ledger <path>`.

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
