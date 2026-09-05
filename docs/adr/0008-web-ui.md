# ADR-0008: The web UI is served by the daemon, with no framework and no build step

- Status: Accepted
- Date: 2026-09-05

## Context

The boundary has an operator surface: held calls to approve or reject,
dead letters to replay, the ledger to read, and from 0.6 the tool
rankings, signatures and the weekly report. The command line covers all
of it, but a held call is a notification someone has to see in seconds,
and a ranking is a table someone scans, not a JSON dump. The roadmap puts
a web UI at 0.7 and a Tauri desktop shell at 0.10.

Two shapes were on the table: a separate front-end package with its own
tool chain and a dev server, or pages the daemon serves itself.

## Decision

### The daemon serves it

The UI is static files inside `@sayagain/proxy` (`dist/ui`), served by
the daemon at `/ui`. Same origin as the control API, so no CORS, no second
port, no second process, and one bearer token. `sayagain ui` opens the
browser at `http://127.0.0.1:7777/ui` with the token on the query string;
the page moves the token into `sessionStorage` at once and sends it as a
header from then on. The daemon accepts the query form on `GET /ui` only,
as it already does for event streams. A Tauri shell (0.10) embeds the same
pages and supplies the token itself.

### No framework, no bundler

The pages are hand-written HTML with one TypeScript module per screen,
compiled by the same `tsc` build as the rest of the package into plain ES
modules. No React, no bundler, no CSS framework, nothing loaded from a
CDN. The reasons:

- The package stays dependency-free, which is what lets it be audited and
  what keeps `npx` fast.
- The screens are tables, a list, and a handful of buttons; the platform
  can do that without a virtual DOM.
- Content Security Policy can be strict: scripts and styles from `self`
  only, no inline script, no remote origin at all. Nothing on the page
  can leak the token or the ledger.

If the UI outgrows this (the learning loop's editors in 0.8 may), the
decision to revisit is the framework, not the origin.

### What 0.7 ships

In the order a person needs them:

1. **Holds inbox.** Live over `/api/events`; approve and reject in place;
   orphaned holds marked as such. This is the screen that justifies the UI.
2. **Servers.** Registered upstreams, whether each is started and ready,
   sessions attached, the daemon's own health and export endpoint.
3. **Dead letters** with replay, optionally with edited arguments.
4. **Ledger** tail with filters by server, tool and status.
5. **Tools, errors, report**: the 0.6 analysis rendered as tables, from
   three new JSON routes (`/api/tools`, `/api/errors`, `/api/report`) so
   the browser never computes over the ledger itself.

Settings, `learn`, and anything that edits the registry from the browser
wait for 0.8, when there is something to edit.

### Security posture

Loopback only, as the daemon is. The token is the only credential; the
page never stores it beyond the tab. CSP `default-src 'self'`; no forms
that post to the daemon without the header; every mutating action is a
`POST` with the token. The UI shows argument values of held calls, as
the CLI does, because the operator deciding on a call must see what it
does; nothing leaves the machine.

## Alternatives considered

- **A separate SPA package with Vite.** Faster to iterate for a front-end
  team, but a second tool chain, a build step in CI, a dependency tree the
  size of the rest of the repository, and a dev server the daemon would
  have to proxy. Rejected for now.
- **Tauri first.** The desktop shell needs the pages anyway; building the
  pages inside the daemon means they also work in a browser tab on a
  machine without the app.
- **A hosted console only.** The hosted tier shows the same objects across
  a team; the local UI is what a solo operator needs today, and the hosted
  console can embed it.

## Consequences

- `@sayagain/proxy` ships HTML and CSS in its tarball; `files` gains
  `dist/ui`. The build copies static assets next to the compiled modules.
- The daemon gains `/ui` and three JSON routes over `analysis.ts`; the CLI
  gains `sayagain ui`.
- Screens are tested where they matter: the routes by the daemon tests,
  the pages by a smoke that fetches them and checks the CSP header and the
  absence of remote origins.
