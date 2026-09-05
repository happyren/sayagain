# sayagain

The `sayagain` command: the commitment boundary for MCP tool calls.

```bash
npm install -g sayagain
sayagain hosts                        # what Claude Code, Cursor, Claude Desktop and VS Code have configured
sayagain import --host all --rewrite  # wrap every server, keeping each host's keys; backups kept
sayagain eject --host all             # and back
```

This package only provides the command. The implementation, the library
API and the changelog live in
[`@sayagain/proxy`](https://www.npmjs.com/package/@sayagain/proxy); the
project, its design records and its measurements are at
[github.com/happyren/sayagain](https://github.com/happyren/sayagain).
