## What

One or two sentences. Link the issue or ADR if there is one.

## Side-effect analysis

Required if this touches arguments of a non-read-only tool, the hold path,
replay, or deduplication. Otherwise write "not applicable".

- Can this cause a call to execute that should have been held?
- Can this cause a non-idempotent call to execute more than once?
- Are argument changes recorded in `sh.sayagain/repair`?

## Checklist

- [ ] Tests cover the behaviour change
- [ ] `spec/intent-metadata.md` and its changelog updated, if the wire format changed
- [ ] Commits are signed off (`git commit -s`)
