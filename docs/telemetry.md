# Telemetry schema (draft)

Per [ADR-0005](adr/0005-argument-free-telemetry.md), telemetry is opt-in,
off by default, and never carries argument values, content, intent text or
task text. This is the complete list of fields a telemetry event may carry.

| Field             | Type    | Notes                                              |
| ----------------- | ------- | -------------------------------------------------- |
| `server`          | string  | MCP server name from `initialize`                  |
| `serverVersion`   | string  |                                                    |
| `tool`            | string  | Tool name                                          |
| `argKeys`         | list    | Argument key names and JSON types, never values    |
| `toolClass`       | enum    | `read-only`, `idempotent-write`, `write`, `destructive` |
| `status`          | enum    | See spec section 5.2                               |
| `errorClass`      | enum    | `transport`, `schema`, `server-error`, `timeout`, `semantic`, `unknown` |
| `repairKind`      | enum    | `coerce`, `rename`, `default`, `model`, or absent  |
| `repairRule`      | string  | Deterministic rule id, when applicable             |
| `holdReason`      | enum    |                                                    |
| `attempts`        | int     |                                                    |
| `latencyMs`       | int     | Boundary overhead only                             |
| `tokensSaved`     | int     | Estimated, from context size on avoided retries    |
| `modelFamily`     | string  | Coarse: `claude`, `gpt`, `gemini`, `open-weight`   |
| `proxyVersion`    | string  |                                                    |

Anything not in this table is not sent. Changes require an ADR.
