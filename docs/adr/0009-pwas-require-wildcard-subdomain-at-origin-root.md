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
- or a dedicated wildcard host such as `*.a.artifacts.thefocus.ai` if that fits
  existing DNS better

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
  is DNS-only (not proxied). A wildcard for the chosen host
  (`*.artifacts.thefocus.ai` or `*.a.artifacts.thefocus.ai`) must follow the
  same DNS-only posture so TLS and routing stay with Vercel.
- **SSL.** Add the matching wildcard domain on the Vercel project and use
  Vercel's automatic certificate. This ADR does not add that domain.
- **Routing.** Host-header routing maps the wildcard host to the same Blob serve
  path the `/a/{opaque}` rewrite uses today. Implementation is follow-on work;
  this record only requires that PWAs be reached as `/` on the wildcard host,
  not as a path on the apex.
- **Isolation.** A per-Publication origin gives each PWA its own storage,
  cookies, permissions, and service worker. That is the point of rejecting
  path-scoped install.
- **Ordinary Artifacts stay on `/a/`.** Path-hosted Publications, unlisted
  posture, and `Cache-Control: no-store` are unchanged. `/a/` is not a PWA
  surface.
- **Out of scope here.** Wildcard DNS, Vercel domain/cert, and host-header
  routing are not implemented by this ADR. Later work implements the accepted
  shape; it must not reopen path-scoped PWAs.
