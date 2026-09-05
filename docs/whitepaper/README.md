# Tool Definition Best Practices for MCP (whitepaper outline)

Working title. The linter (`@sayagain/lint`) implements ten of the fifteen rules (the catalogue marks the rest as intent; `RULE_SET_VERSION` dates the set); this
document explains them. Draft sections:

1. **Why descriptions fail.** Original descriptions cover under 12 percent
   of the information a model needs; frontier models are schema-compliant
   but choose the wrong tool or the wrong value.
2. **The five missing-information categories.** Tool scope and boundaries;
   parameter constraints, formats and enums; cross-tool dependencies and
   ordering; output description; cross-parameter dependencies.
3. **Naming and annotations.** MCP tool-name rules; `readOnlyHint`,
   `destructiveHint`, `idempotentHint`, `openWorldHint` and when each is
   load-bearing for a boundary.
4. **Schemas that fix format, not intent.** What `strict` buys and what it
   does not; examples as the cheapest accuracy lever.
5. **Writing for a proxy.** Idempotency, postconditions, and how to make a
   tool safe to hold and replay.
6. **Stating intent.** The `sh.sayagain/intent` convention and the schema
   shim; guidance for host and SDK authors.
7. **Scoring.** How the linter grades a server; what "A" means.

Companion: results of running the linter across the public registry.
