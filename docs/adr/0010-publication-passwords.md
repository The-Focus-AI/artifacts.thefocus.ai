# Publications can require a password

## Status

proposed

## Context

A Publication is Unlisted: anyone who has the URL can open it. Some Artifacts
need more than that, for example a client report whose URL gets forwarded.

The request path already suits a gate. Every Publication request, on `/a/` and
on a PWA wildcard host, goes through `servePublicationRequest`. The function
reads the Artifact from Blob on the server and returns the bytes. A viewer never
receives a Blob URL.

## Decision

A Publisher can set a Publication Password. A viewer must enter it before any
Artifact Path is served.

- **Set and clear.** `publish --password`, `password <Publication URL> --set`,
  `--clear`, and `--unlock-for`. MCP: `password` and `unlockFor` on
  `publish_artifact` and `update_artifact`, plus `set_artifact_password`.
- **Storage.** `publications.password_hash` holds an scrypt hash with its own
  cost parameters and salt. `publications.unlock_ttl_ms` holds the optional
  unlock limit. The API and MCP list responses send `hasPassword`, never the
  hash.
- **Gate.** A request without a valid Unlock gets a 401 password page. The page
  has no Title, Open Graph tags or Artifact content. The gate covers every
  Artifact Path.
- **Unlock.** A correct password sets one `HttpOnly` cookie scoped to the
  Publication path. The cookie holds a timestamp and an HMAC of it. The HMAC key
  is the stored password hash.
- **Attempt limit.** One client address can submit ten passwords per minute
  for one Publication. Further attempts in that minute return 429, including the
  correct password. Each attempt is a row in `publication_unlock_attempts`,
  written before the password is checked, so parallel guesses cannot slip
  under the limit.
- **Who can change it.** Any Publisher, the same as Removal.

## Considered options

- **A signing secret in the environment.** Rejected. Signing with the stored
  hash needs no new secret in 1Password or Vercel. The hash never leaves the
  server. A changed or cleared password changes the key, so every earlier
  Unlock stops working with no extra bookkeeping.
- **Viewer accounts.** Rejected. Viewers are clients without TheFocus.AI
  accounts. A shared password matches how Publication URLs are already handed
  out.
- **Per-recipient share links, each with its own password, expiry and view
  limit.** Left out. They are a larger feature with their own table and URL
  shape.
- **Passwords on PWA Publications.** Left out. A service worker caches the app
  shell and serves it without a request to the server, and the wildcard host
  needs its own cookie design. Publishing refuses the combination. The serve
  path still applies the gate when a Publication has a hash, so a PWA
  Publication that somehow has one stays closed.
- **Private Blob storage.** Left out. Artifact bytes are written to Vercel Blob
  with `access: "public"`.

## Consequences

- **Unlisted still holds.** A Publication with a password is still absent from
  indexes and listings. `CONTEXT.md` defines Publication Password and Unlock.
- **Not private at rest.** The gate protects the Publication URL. A Blob URL
  would bypass it. No response sends a Blob URL to a viewer today, and a change
  that does would break the gate.
- **POST on a Publication URL.** `servePublicationRequest` now accepts POST for
  the password form. A Publication without a password still returns 405. A POST
  to a URL with no Publication returns 404; before this it returned 405. A POST
  that a browser marks `Sec-Fetch-Site: cross-site` gets 403 and does not count
  as an attempt, so a form on another site cannot lock a viewer out.
- **Headers reach the serve function.** `servePublicationNodeRequest` forwards
  request headers and the POST body. Before this, it forwarded the method only.
- **A Local Source keeps its password.** Publishing the same Local Source after
  the Revision Window creates a new Publication. The CLI sends the earlier
  Publication URL from its Local State (`keepPasswordFrom`), and the server
  copies that Publication's password hash and unlock limit to the new one. The
  server copies only from a Publication with the same Publisher and the same
  Local Source. `--password` replaces the password and keeps the limit. `--new`
  copies nothing. A publish with no Local State (another computer, MCP) or from
  stdin starts with no password.
- **Known limits, not fixed here.** A password change that runs at the same
  moment as a publish of the same Publication can write back the earlier
  Artifact locator (the store reads the row, then writes it). Each password
  POST inserts one row, including a refused one. Publications share one origin
  under `/a/`, so a script in one Publication can request another in a browser
  that has unlocked it. The client address is the first `x-forwarded-for`
  entry; we have not checked how each serving domain sets that header.
- **The password page has no brand.** Publications are served from more than
  one domain. The page's label is the request host, its colors follow the
  viewer's light or dark setting, and it loads no web fonts.
- **The attempt limit is per address.** An attacker with many addresses gets
  ten tries per minute from each. Passwords are 4 to 200 characters; short passwords are
  weak against that.
- **Migration.** `migrations/0009_add_publication_passwords.sql` must be applied
  before the code is deployed.
- **Living Docs.** Not covered. View Links and Review Links are unchanged.
