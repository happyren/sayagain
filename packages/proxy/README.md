# @sayagain/proxy

The commitment boundary for MCP tool calls: the `sayagain` command and the
`Boundary` core behind it.

A tool call crosses a trust boundary with no acknowledgement, no
transaction, no dead-letter queue and no replay. Say Again sits between MCP
clients and MCP servers and owns that boundary. Every result carries a
receipt; calls that must not run twice are deduplicated; destructive calls
are held for a decision; failures with a known fix are repaired; the rest
are dead-lettered and can be replayed with the agent's original intent.

```bash
npm install -g @sayagain/proxy        # or: npx -p @sayagain/proxy sayagain ...

# One command wraps every server your hosts know about; one puts it back.
sayagain hosts
sayagain import --host all --rewrite
sayagain eject --host all

# Or by hand: register upstreams, start the daemon, point hosts at it.
sayagain add notion -- npx -y @notionhq/notion-mcp-server
sayagain serve --detach
#   host entry: "notion": { "command": "~/.sayagain/bin/sayagain", "args": ["stdio", "notion"] }

# Or wrap one stdio server in place, no daemon.
sayagain wrap -- npx -y @notionhq/notion-mcp-server

sayagain holds | approve <receipt> | reject <receipt>
sayagain deadletters | replay <receipt>
sayagain ledger --tail 20
```

The library exports the same pieces (`Boundary`, `startDaemon`, `wrap`,
`openStores`, the transports) for embedding.

Requires Node.js 22.13 or newer. The wire convention is
[`spec/intent-metadata.md`](https://github.com/happyren/sayagain/blob/main/spec/intent-metadata.md);
the design records, roadmap and measurements are in the
[repository](https://github.com/happyren/sayagain). Apache-2.0.
