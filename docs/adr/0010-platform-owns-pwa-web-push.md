# Platform Web Push is the Artifacts product for PWA notifications

## Status

accepted

## Context

Installable Artifacts PWAs already have a locked URL shape
(`docs/adr/0009-pwas-require-wildcard-subdomain-at-origin-root.md`): each PWA
is a static Blob-served Publication at
`https://{opaque}.artifacts.thefocus.ai/`. Ordinary Publications stay on
`/a/{opaque}`. Path-scoped `/a/{id}/` PWAs remain rejected.

That hosting shape is necessary and not sufficient for push. A PWA at the
origin root can register a service worker and request notification permission.
It still has **no per-PWA backend**. There is nowhere in the static bundle to
keep a VAPID private key, store `PushSubscription` records, or fan out a send
without handing every publisher a custom server.

Bring-your-own push (drop a third-party SDK into the static bundle, or mint a
per-artifact VAPID pair) would make notifications a publisher homework
problem. Most Artifacts PWAs are agent-published static apps. The product
owner locked **platform push**: Artifacts owns the keys, the store, and the
authenticated send path so every installable PWA can opt in.

This ADR locks that product approach and sketches the schema and API. Live
Web Push delivery (the `web-push` fanout against real push services) is
follow-up work once VAPID secrets exist in 1Password/Vercel. The HTTP
subscribe/unsubscribe/send contract and Neon table are specified here so
implementation does not relitigate the product.

## Decision

**Artifacts owns platform Web Push for every installable PWA.** BYO push is
not the v1 product. Advanced publishers may still embed a third-party SDK at
their own risk; Artifacts will not store those subscriptions or send on that
path, and agents must not propose BYO as the Artifacts notification solution.

### Keys

The platform holds **one** Artifacts VAPID key pair, configured as environment
variables on Vercel (declared in `fnox.toml`, stored in the 1Password
`Artifacts` vault):

- `VAPID_PUBLIC_KEY` — served to PWA clients
- `VAPID_PRIVATE_KEY` — server-only; never committed, never sent to a
  browser, never written into a Publication bundle
- `VAPID_SUBJECT` — contact URL or `mailto:` for the VAPID JWT `sub`

Do not generate or commit real private keys in this repository. Do not mint a
per-Publication VAPID pair in v1.

### Subscription store

Subscriptions live in Neon (`migrations/0009_create_pwa_push_subscriptions.sql`),
keyed primarily by the Publication's `opaque_id`:

- `id`, `opaque_id` (FK to `publications.opaque_id`), `endpoint` (unique),
  `p256dh`, `auth`, nullable `user_agent`, `created_at`, `last_seen_at`
- index on `opaque_id`; unique on `endpoint`

Ownership checks use `publications.publisher_email`, not a denormalized
publisher column. When a send receives HTTP `410 Gone` from a push service,
the application deletes that endpoint. That cleanup is not a SQL job.

### Public client endpoints

Unauthenticated, CORS-safe for the PWA origin, scoped to the host-derived
opaque id. Prefer the PWA host so the id is not a client-supplied field:

| Method | Path on `https://{opaque}.artifacts.thefocus.ai` | Purpose                              |
| ------ | ------------------------------------------------ | ------------------------------------ |
| `GET`  | `/api/push?action=vapid-public-key`              | Platform VAPID public key            |
| `POST` | `/api/push?action=subscribe`                     | Store a `PushSubscription` JSON body |
| `POST` | `/api/push?action=unsubscribe`                   | Remove by `endpoint`                 |

`middleware.ts` must leave `/api/push` alone on a wildcard host (same
exclusion shape as `/api/pwa`) so these routes are not rewritten to the
static Artifact. The handler derives `opaque_id` from
`{opaque}.artifacts.thefocus.ai` and looks up `publications` case-insensitively
(DNS labels are case-insensitive). A body field named `opaqueId` is ignored.
These routes refuse the apex host and refuse `/a/{opaque}` — there is no
path-hosted push surface.

Push is **opt-in per install**. The browser permission prompt is the
installer's choice. Artifacts never auto-subscribes a PWA, never writes a
subscription at publish time, and never injects push handlers into an
arbitrary publisher bundle in v1. The publisher's service worker must include
the documented `push` / `notificationclick` contract
(`docs/pwa-push.md`).

### Privileged send

Send is the same auth family as MCP/CLI: a Publisher Token (`tfai_pub_` /
`tfai_mcp_`) or an OAuth access token the MCP client already holds. Only the
Publisher who owns that Publication may send. The target is a PWA Publication
URL, not a raw opaque id the client invented:

```http
POST https://artifacts.thefocus.ai/api/push?action=send
Authorization: Bearer tfai_pub_...
Content-Type: application/json

{ "publicationUrl": "https://{opaque}.artifacts.thefocus.ai/",
  "title": "…", "body": "…", "url": "/", "data": {} }
```

Rate-limit sends per Publisher per Publication. The v1 limiter in this PR is
an in-process stub; a shared limiter is follow-up.

CLI sketch (wired to the HTTP send action):

```bash
npx @the-focus-ai/artifacts push send \
  --url https://{opaque}.artifacts.thefocus.ai/ \
  --title "Hello" \
  --body "A notification"
```

MCP `send_pwa_push` uses the same arguments and the same send path as the
CLI/HTTP surface.

### Rejected approaches

- **Path-hosted push under `/a/{opaque}`.** Rejected with ADR-0009. A
  path-scoped worker cannot own notification permission for an installable
  PWA origin. Do not add `/a/{id}/api/push`.
- **Per-artifact custom VAPID as v1.** Rejected. One platform pair is the
  product; per-app keys reintroduce BYO operations.
- **Third-party push SDK in the static bundle with no Artifacts store.**
  Rejected as the product. There is no per-PWA backend to complete that
  story, and Artifacts would not be able to send.

## Considered options and why they were rejected

- **Platform push (this decision).** Chosen. Artifacts already has Publisher
  auth, Neon, and a distinct PWA origin. Owning VAPID + subscriptions + send
  is the smallest complete product that works for static PWAs.
- **BYO as the product.** Rejected. Every publisher would need a server or a
  vendor account. That is not an Artifacts skill; agents would fail closed or
  leak private keys into Blob.
- **Per-Publication VAPID.** Rejected for v1. Operational cost, no user-facing
  gain while Artifacts is the only sender.
- **Send unauthenticated or capability-URL send.** Rejected. A PWA URL is
  unlisted, not a send capability. Fanout is privileged.

## Consequences

- **ADR-0009 is unchanged.** PWA URLs stay `{opaque}.artifacts.thefocus.ai` at
  `/`. This decision adds a platform API on that origin; it does not reopen
  path-scoped PWAs.
- **Neon apply is a human/ops step.** Commit
  `migrations/0009_create_pwa_push_subscriptions.sql` and apply it to the
  Artifacts Neon database before treating subscribe as live. This PR does not
  apply the migration.
- **VAPID secrets are ops, not code.** Create the pair out of band, store the
  values in 1Password vault `Artifacts`, and set them on Vercel. Never commit
  them. Until they exist, `GET vapid-public-key` and send both return `503`.
  Send does not report success without VAPID.
- **iOS.** Safari Web Push requires the PWA to be added to the Home Screen.
  That is a platform consequence, not a blocker and not an Artifacts bug.
- **Service worker contract.** Publishers (or the agent that authors the PWA)
  include subscribe logic in the page and `push` / `notificationclick` in
  `/sw.js`. Artifacts does not rewrite uploaded service workers in v1.
- **Removal.** Marking a Publication removed stops new subscribes and send.
  Rows remain until a hard delete or 410 cleanup. Follow-up may drop
  subscriptions when `publications.status` becomes `removed`.
- **Implementation status (honest).** Design is accepted and send fans out
  with `web-push` when VAPID env vars are present. Remaining ops: apply
  migration 0009 on Neon and set the three VAPID variables on Vercel. Rate
  limiting is a process-local per-Publisher-per-Publication guard. See
  `docs/pwa-push.md`.
