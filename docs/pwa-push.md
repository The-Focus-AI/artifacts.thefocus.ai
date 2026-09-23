# Platform Web Push for Artifacts PWAs

Status: **accepted design** (`docs/adr/0010-platform-owns-pwa-web-push.md`).
Subscribe/send HTTP stubs ship in this repo. Live `web-push` fanout is **not**
on until VAPID secrets exist in 1Password/Vercel and Neon has
`migrations/0009_create_pwa_push_subscriptions.sql` applied.

PWAs stay at `https://{opaque}.artifacts.thefocus.ai/` (ADR-0009). Artifacts
does not inject service-worker handlers into a publisher bundle in v1. The
page and `/sw.js` (or `/service-worker.js`) must follow this contract.

## How a PWA subscribes

1. User installs or opens the PWA on its wildcard origin (iOS: add to Home
   Screen first).
2. The page asks for notification permission. Artifacts never auto-subscribes.
3. Same-origin fetch of the platform public key, then `pushManager.subscribe`.
4. `POST` the resulting `PushSubscription` JSON to `/api/push?action=subscribe`.
   The server takes `opaque_id` from the host, not from the body.

```js
async function subscribeToArtifactsPush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch("/api/push?action=vapid-public-key").then(
    (response) => response.json(),
  );
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await fetch("/api/push?action=subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const raw = atob(base64String.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
```

Unsubscribe:

```js
await fetch("/api/push?action=unsubscribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ endpoint: subscription.endpoint }),
});
```

## Service worker handlers

Include these in the PWA's own `/sw.js`. Artifacts does not rewrite the
uploaded worker.

```js
self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(payload.title || "Artifacts", {
      body: payload.body || "",
      data: { url: payload.url || "/", ...payload.data },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(self.clients.openWindow(target));
});
```

Do not put a third-party push SDK in the static bundle as the Artifacts
product, and do not host push under `/a/{opaque}`.

## How a publisher or agent sends

Authenticated with a Publisher Token (or, later, MCP OAuth). Only the
Publisher who owns the PWA Publication can send.

```bash
npx @the-focus-ai/artifacts push send \
  --url https://{opaque}.artifacts.thefocus.ai/ \
  --title "Hello" \
  --body "A notification" \
  --click-url /
```

HTTP equivalent:

```http
POST https://artifacts.thefocus.ai/api/push?action=send
Authorization: Bearer tfai_pub_...
Content-Type: application/json

{
  "publicationUrl": "https://{opaque}.artifacts.thefocus.ai/",
  "title": "Hello",
  "body": "A notification",
  "url": "/"
}
```

Until `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` are set and
a `WebPushSender` is wired, send authorizes, rate-limits, and reports
`implementation: "stubbed"` with `subscriptionCount`. It does not call a push
service. HTTP 410 cleanup of gone endpoints is specified for the live sender.

## MCP (deferred)

Planned tool: `send_pwa_push` with `publicationUrl`, `title`, `body`, optional
`url` / `data`. Not registered on `/mcp` in this change. Use the CLI or HTTP
send until that lands.

## Environment

Declare names only; never commit values:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (`mailto:` or https contact)

Apply `migrations/0009_create_pwa_push_subscriptions.sql` to Neon before
treating subscribe as live.
