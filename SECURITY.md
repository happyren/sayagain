# Security Policy

Say Again sits in the execution path of agent tool calls, including writes.
We treat correctness of the hold, replay and repair paths as security
properties.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/sayagain-dev/sayagain/security/advisories/new).
Do not open a public issue.

You will get an acknowledgement within 3 business days and a status update at
least every 14 days. We aim to ship a fix within 90 days of a confirmed report
and will credit you in the advisory unless you ask otherwise.

## In scope

- `@sayagain/proxy`: anything that lets a held call execute without
  approval, lets a non-idempotent call execute more than once, mutates the
  arguments of a write call without a `sh.sayagain/repair` record, leaks
  one tenant's ledger to another, or bypasses the pre-call hook.
- `@sayagain/sdk` and `@sayagain/lint`: injection through tool
  descriptions or schemas, unsafe deserialisation, dependency issues.
- The `spec/` document: ambiguities that would lead a conforming
  implementation to unsafe behaviour.

## Out of scope

- Prompt injection against the model itself. Say Again's intent-drift
  detection is a mitigation, not a guarantee, and the spec says so.
- Vulnerabilities in upstream MCP servers or in gateways Say Again runs
  behind.
- Denial of service through volume alone; rate limiting belongs to the
  gateway.

## Supported versions

Pre-1.0: only the latest minor release receives fixes.
