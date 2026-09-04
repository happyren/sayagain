# ADR-0001: Apache-2.0 everywhere, DCO, enterprise code in a separate repository

- Status: Accepted
- Date: 2026-09-04

## Context

The project's moat is not its code. A queue, retry and dead-letter queue is
a quarter's work for any gateway vendor. The durable assets are the
convention (`spec/`), the corpus of failures and fixes, and a policy engine
inside a compliance approval path. Two of those three require other people
to implement the convention, including competitors and hyperscalers.

The distribution plan includes shipping as a plugin inside Apache-2.0
gateways (IBM ContextForge, agentgateway) and MIT-licensed routers
(LiteLLM), and proposing the convention to the Model Context Protocol
community, whose specification is MIT-licensed and whose foundation home
uses Apache-2.0 for code.

## Decision

- All code and documents in this repository are licensed Apache-2.0,
  including the specification. One license, no per-directory exceptions.
- Contributions are accepted under the Developer Certificate of Origin, not
  a contributor license agreement.
- Trademark is the only reserved right (TRADEMARK.md). Forks must rename.
- Commercial features (SSO, SCIM, RBAC, audit export, approval workflows,
  hosted console) live in a separate private repository and load as a
  plugin against public extension points. Nothing in this repository
  depends on them.

## Alternatives considered

- **AGPL-3.0.** Blocks hyperscaler hosting in theory, but blocks the plugin
  route in practice: none of the target gateways can vendor AGPL code, and
  enterprise legal teams routinely ban it. Distribution is the binding
  constraint, so this loses.
- **FSL or BSL with delayed conversion.** Protects against a competing
  hosted offering, but it is not open source by the OSI definition, weakens
  the "reference implementation of a standard" story, and requires a CLA to
  administer. The threat it defends against (a gateway vendor copying the
  proxy) is not the real threat; they will write their own.
- **`ee/` directory under a commercial license** (Langfuse, GitLab model).
  Works, but introduces per-file license ambiguity in a repository we want
  gateway vendors to vendor pieces of. A separate repository is cleaner.
- **CLA.** Gives relicensing optionality. Relicensing is the single most
  trust-destroying move a project can make, and the moat does not live in
  the code, so the option is not worth the friction. The DCO is also what a
  foundation donation expects.

## Consequences

- A hyperscaler can ship the proxy as a managed service. Accepted; the
  convention and corpus are where value compounds, and their adoption helps
  both.
- Relicensing later requires every contributor's consent. Intended.
- Commercial features must be designed against public extension points from
  the start, which also keeps the open-source proxy honest.
