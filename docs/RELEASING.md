# Releasing

Modelled on Docent: a version tag drives the release, minor versions carry
features, patch versions carry fixes, and the cadence is as often as a slice
is done. The differences come from this repository's rules: `main` only
takes pull requests, and the packages publish to npm.

## Versioning

- One version for the whole workspace. The root `package.json` and every
  `packages/*/package.json` carry the same number and move together.
- `0.x`: a new slice from `docs/ROADMAP.md` is a minor bump; a fix is a
  patch bump. Breaking changes to the wire convention are allowed in `0.x`
  and are called out in `spec/intent-metadata.md`'s changelog.
- `1.0.0` when the spec is frozen and the A/B gate in the roadmap is met.

## Steps

1. Land the slice on `main` through its pull request, with `CHANGELOG.md`
   updated under `Unreleased`.
2. From `main`, run the release script for a minor or patch bump:

   ```bash
   node scripts/release.mjs minor     # or: patch, or an explicit 0.4.2
   ```

   It bumps every version, moves `Unreleased` into a dated section, commits
   on a `release/vX.Y.Z` branch with a sign-off, pushes it, and opens the
   pull request. Nothing is tagged yet.
3. Merge that pull request once `check` and `DCO` pass.
4. Tag the merge commit and push the tag:

   ```bash
   node scripts/release.mjs tag
   ```

   It refuses if `main` is not at the release commit.
5. The `Release` workflow runs on the tag: full check, build, `pnpm publish`
   for every public package with npm provenance, then a GitHub Release whose
   notes are that version's section of `CHANGELOG.md`.
6. From 0.10 on, the `Desktop` workflow also runs on the tag and attaches
   the Tauri bundles, as Docent's does.

## Secrets and settings

- `NPM_TOKEN`: an npm automation token for the `@sayagain` scope, or npm
  trusted publishing configured for this repository, in which case the
  token is not needed.
- The `Release` workflow needs `contents: write` for the GitHub Release and
  `id-token: write` for provenance; both are declared in the workflow.

## Rollback

npm versions are immutable; publish a patch that reverts. A GitHub Release
can be deleted, but the tag stays; do not reuse a tag.
