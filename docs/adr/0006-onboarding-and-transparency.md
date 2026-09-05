# ADR-0006: Onboarding in one command, identity preserved end to end

- Status: Accepted
- Date: 2026-09-04

## Context

The boundary is worth nothing when it is not in the path, and every manual
step between "I heard of it" and "it is in the path" loses users. Three
requirements were set:

1. Adding an upstream MCP server to the boundary is one command.
2. Pointing a host (Claude Code, Cursor, Claude Desktop, VS Code, a custom
   agent) at the boundary is one command, and works with the host's own
   configuration format.
3. The agent must still know it is talking to Notion. The server name, tool
   names, descriptions, schemas, resources and prompts it sees are the
   upstream's. The boundary is visible only where a client chooses to look.

Hosts name servers by the key in their own configuration, and prefix tool
names with that key (Claude Code: `mcp__notion__search_pages`). Identity on
the agent side is therefore the configuration key plus the upstream's own
`tools/list`. Anything that changes either loses identity.

## Decision

### Topology: one virtual server per upstream, never an aggregator

Every upstream gets its own boundary endpoint. The host's entry for `notion`
points at the boundary's `notion` endpoint, under the same key. One
long-running local daemon multiplexes all of them:

- HTTP: `http://127.0.0.1:7777/mcp/<name>`, one route per registered server,
  for hosts that speak Streamable HTTP. The 2026-07-28 stateless model makes
  this a plain reverse proxy with a ledger.
- stdio: `sayagain stdio <name>`, a thin shim that forwards to the daemon,
  for hosts that only spawn commands. The shim starts the daemon if it is
  not running.

An aggregator that exposes every upstream's tools behind one endpoint is
rejected as the default. It collapses server identity into a name prefix,
and it multiplies schema tokens per turn by the number of servers, which is
the cost the product is supposed to reduce. It remains available as an
explicit `sayagain serve --aggregate` for hosts that can take only one
server.

### Identity passthrough rules

| Surface | Rule |
| ------- | ---- |
| Host configuration key | Unchanged. `import --rewrite` keeps every key. |
| Tool names | Never renamed, never prefixed. |
| Tool descriptions and schemas | Unchanged, except the optional schema shim (ADR-0003), which adds properties to non-read-only tools and never removes or renames any. Off by default. |
| `initialize` result `serverInfo` and `capabilities` | Relayed verbatim. The boundary does not advertise capabilities the upstream lacks. |
| `initialize` result `instructions` | Relayed, with one appended sentence naming the boundary and the receipt, held and repaired statuses. `announce = false` removes it. |
| Resources, prompts, completions, logging | Relayed. The boundary is a full MCP passthrough, not a tools-only filter. |
| Notifications, including `tools/list_changed` | Relayed, and the boundary invalidates its cached `tools/list` when they arrive. |
| Errors from upstream | Original code and message preserved. Error rewriting appends guidance; it never replaces the upstream text. |
| Result content | Untouched. The boundary adds `_meta` keys only (spec section 5). |

The boundary announces itself once, on the `initialize` result, as
`_meta["sh.sayagain/boundary"]` (spec section 5.5): its version, the
upstream name, the ledger kind and whether the shim is on. A client that
wants to show "via Say Again" reads it; every other client ignores it.

### Onboarding commands

```bash
# Thirty seconds, one server, no configuration: wrap the command in place.
npx sayagain wrap -- npx -y @notionhq/notion-mcp-server

# Register upstreams with the daemon.
sayagain add notion -- npx -y @notionhq/notion-mcp-server
sayagain add linear --url https://mcp.linear.app/mcp --header "Authorization=Bearer ${LINEAR_TOKEN}"

# Adopt everything a host already has, keep the keys, rewrite the host
# config to point at the boundary, back up the original first.
sayagain import --from claude-code --rewrite        # cursor | claude-desktop | vscode | <path>
sayagain import --from ./.cursor/mcp.json --dry-run

# Or write host entries for registered servers without importing.
sayagain install --host claude-code

# Undo. Restores the backup or rewrites entries back to direct.
sayagain eject --host claude-code

sayagain status | list | ledger | holds | replay <receipt>
```

`wrap` runs the boundary in-process with a JSONL ledger and no daemon. It
is the demo path and the fallback when the daemon cannot start. `add`,
`import` and `install` write `~/.sayagain/config.json` (JSON, not TOML: no
parser dependency yet) and the host's own
file, in the host's own format, with a timestamped backup beside it.

Registered server entry (`~/.sayagain/config.json`, 0600):

```json
{
  "servers": {
    "notion": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "${NOTION_TOKEN}" },
      "classes": { "delete_page": "destructive" },
      "hold": "destructive",
      "announce": true
    },
    "linear": {
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" }
    }
  },
  "daemon": { "listen": "127.0.0.1:7777", "store": "jsonl" }
}
```

Host entry written by `install` (Claude Code, HTTP transport):

```json
"notion": {
  "type": "http",
  "url": "http://127.0.0.1:7777/mcp/notion",
  "headers": { "Authorization": "Bearer <local token>" }
}
```

For hosts without HTTP support the entry is
`{ "command": "sayagain", "args": ["stdio", "notion"] }`.

### Defaults chosen for non-intrusiveness

- **Store**: JSONL files under `~/.sayagain` by default (`ledger.jsonl`,
  `deadletter.jsonl`, `holds.jsonl`), so nothing depends on a Node.js
  feature; `serve --store sqlite` keeps the same data in `sayagain.db`
  (node:sqlite, Node 22.13+). Postgres is a later option for shared and
  hosted deployments. This supersedes the "Postgres dead-letter queue"
  wording in earlier documents.
- **Loopback only, with a token**: the daemon binds `127.0.0.1` and requires
  a bearer token it generates on first run (`~/.sayagain/token`, 0600) and
  writes into host entries itself (`install`, 0.5). Other local processes
  cannot borrow the upstream credentials through the boundary. The user
  never needs to see the token; `sayagain add` names the file for hosts
  configured by hand.
- **Secrets**: `env` values are stored as `${VAR}` references and resolved
  from the daemon's environment at spawn. `import` copies literal values
  into the config only with `--copy-secrets`, and says so.
- **Upstream authentication**: static headers now. OAuth against remote
  upstreams is performed once at `add` time with a browser flow and stored
  by the daemon, the way `mcp-remote` does it. Not in the first release.
- **Failure mode**: closed. If the daemon is unreachable the shim returns a
  clear error; it never silently bypasses to the upstream, because a
  bypass removes the guarantees without telling the operator. Per-server
  `fallback = "direct"` opts out for tools that are not worth a hold.
- **Auto-start**: the stdio shim starts the daemon on demand. Optional
  `sayagain service install` registers it with launchd or systemd.

### Host-native adapters

Some hosts expose an interception point that is cheaper than a proxy: Claude
Code's `PreToolUse` and `PostToolUse` hooks can hold or annotate a call
without a network hop, LangChain's middleware and the Vercel AI SDK's repair
hook can do the same in-process. These are adapters that talk to the same
daemon and write to the same ledger. They are welcome, they are secondary,
and they are never the only path, because the proxy is the one that works
with every host.

## Alternatives considered

- **Aggregator as the default.** See above. Loses identity and spends
  tokens.
- **Host plugin only.** Zero-hop and elegant per host, but every host is a
  separate port and most hosts have no interception point at all.
- **Rewrite the upstream's `serverInfo.name` to "notion via Say Again".**
  Rejected. Some hosts display it, some log it, none treat it as an
  extension point. `_meta` is the sanctioned place.

## Consequences

- The boundary must implement the whole MCP surface as a passthrough, not
  only `tools/call`. This is more work up front and removes a class of
  "it broke my prompts" bugs later.
- `import` must understand at least four host formats and their transport
  quirks, and must keep backups it can restore. It is the most-used command
  and gets the most tests.
- The daemon is a new long-lived process on the user's machine. `status`,
  auto-start and a clean `eject` are the mitigations.
- Configuration keys must match between host and boundary. `import`
  guarantees this; manual `add` prints a warning when a host has a
  different key for the same command.
