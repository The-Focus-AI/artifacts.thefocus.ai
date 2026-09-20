# PWAs require a wildcard subdomain at the origin root

## Status

accepted

## Context

Production Artifacts already serve HTTPS on `artifacts.thefocus.ai` (Vercel plus
a custom domain). Ordinary Publications are path-hosted today: `/a/{opaque}` and
nested `/a/{opaque}/{path}` rewrite to the API functions, which stream the
Artifact from Blob with `Cache-Control: no-store` and `X-Robots-Tag: noindex,
nofollow`.

That path-hosted shape is the right URL for a shareable, unlisted Publication.
It is the wrong origin for an **installable PWA**. A web app manifest's
`start_url` / `scope` and the service worker registration are origin-and-path
scoped. A PWA hanging under `https://artifacts.thefocus.ai/a/{opaque}/…` cannot
own the origin root, shares storage and worker scope with every other path on
the same host, and cannot be proposed as "already HTTPS, so we are done."

HTTPS on the existing path is a prerequisite, not a PWA product. This ADR locks
the hosting shape before anyone implements wildcard DNS or host-header routing.

## Decision

**Artifacts PWAs MUST use a real wildcard subdomain where the PWA is served at
the origin root `/`.** This is a product constraint, not an implementation
preference.

Required URL shape:

- `https://{opaque}.artifacts.thefocus.ai/`

A dedicated `*.a.artifacts.thefocus.ai` host was left as a DNS fallback in the
original lock. Implementation chose `{opaque}.artifacts.thefocus.ai` so the
opaque Publication id is the DNS label and no extra host zone is required.

On that host:

- the PWA is the document at `/`
- the manifest `start_url` and `scope` are `/`
- the service worker registers at `/`

Path-scoped PWAs under `https://artifacts.thefocus.ai/a/{opaque}/…` are **not**
an acceptable product approach for installable PWAs. "Just HTTPS on the existing
path" must not be proposed as the PWA solution.

`/a/{opaque}` remains the Publication URL for ordinary Artifacts. This decision
does not migrate or replace path-hosted Publications.

## Considered options and why they were rejected

- **Path-scoped PWA under `/a/{opaque}/`.** Rejected. Scope and service worker
  registration would be a path prefix on the shared `artifacts.thefocus.ai`
  origin. That is not an installable-PWA product: the app does not own `/`,
  cannot isolate storage or permissions from other Publications, and fights the
  browser's origin model. Do not revisit this as a shortcut.
- **Treat existing HTTPS on `/a/{opaque}` as sufficient.** Rejected. Production
  is already HTTPS. Transport security does not give a PWA its own origin, a
  root `start_url` / `scope`, or a root service worker. HTTPS is assumed; it is
  not the decision.
- **Wildcard subdomain at `/`.** Chosen. Each installable PWA is a distinct
  origin at the host root. Manifest and service worker sit where browsers expect
  them. Isolation is a property of the URL, not of extra headers on a path.

## Consequences

- **DNS.** Cloudflare already hosts `thefocus.ai` and the apex Artifacts record
  is DNS-only (not proxied). Add `*.artifacts` as a DNS-only A record to
  `76.76.21.21`, matching the apex. See `docs/deploy.md`. This ADR does not
  change production DNS.
- **SSL.** Add `*.artifacts.thefocus.ai` on the Vercel project and use Vercel's
  automatic wildcard certificate. That domain add is an ops step, not a code
  change.
- **Routing.** `middleware.ts` rewrites `{opaque}.artifacts.thefocus.ai/*` to
  `/api/pwa` before the static filesystem, so a PWA host does not inherit apex
  files such as `/robots.txt`. The handler serves the same Blob Artifact as
  `/a/{opaque}` at origin root `/`. DNS hostnames are case-insensitive, so PWA
  host lookup matches `opaque_id` case-insensitively; `/a/{opaque}` stays
  exact.
- **Isolation.** A per-Publication origin gives each PWA its own storage,
  cookies, permissions, and service worker. That is the point of rejecting
  path-scoped install.
- **Ordinary Artifacts stay on `/a/`.** Path-hosted Publications, unlisted
  posture, and `Cache-Control: no-store` are unchanged. `/a/` is not a PWA
  surface.
- **Publish.** `--pwa` (CLI) and `pwa: true` (MCP) return the wildcard root URL
  and persist `publications.pwa`. Ordinary publishes still print `/a/{opaque}`.
- **Ops still human.** Code serves a known opaque id at `/` on the wildcard
  host. Cloudflare DNS and the Vercel wildcard domain/cert remain human-only
  production steps documented in `docs/deploy.md`.
