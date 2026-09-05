# @sayagain/lint

A linter for MCP tool definitions: names, descriptions, input schemas and
annotations. It grades what a tool tells a model before the first call,
which is where most mis-calls start.

```ts
import { lintTool, grade } from "@sayagain/lint";

const findings = lintTool(tool);      // from a tools/list result
const letter = grade(findings);       // "A" to "F"
```

Part of [Say Again](https://github.com/happyren/sayagain), the commitment
boundary for MCP tool calls. Apache-2.0.
