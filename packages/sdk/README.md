# @sayagain/sdk

Constants, types and client helpers for the Say Again intent metadata on
MCP tool calls: the `sh.sayagain/*` keys in `params._meta` and
`result._meta`, the status vocabulary, tool classification from
annotations, and helpers to attach intent to a call.

```ts
import { META, withIntent, classify } from "@sayagain/sdk";

const params = withIntent({ name: "delete_page", arguments: { id } }, { intent: "remove the draft the user rejected" });
const status = result._meta?.[META.status]; // "executed" | "repaired" | "held" | ...
```

The convention itself is
[`spec/intent-metadata.md`](https://github.com/happyren/sayagain/blob/main/spec/intent-metadata.md).
The boundary that acts on it is
[`@sayagain/proxy`](https://www.npmjs.com/package/@sayagain/proxy). Apache-2.0.
