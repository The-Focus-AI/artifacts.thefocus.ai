import { describe, expect, it } from "vitest";

import {
  InMemoryPublisherTokenStore,
  issuePublisherToken,
} from "../src/auth.js";
import { runCli } from "../src/cli.js";
import { handlePwaPushRequest } from "../src/pwa-push.js";
import { pwaMiddlewareRewriteUrl } from "../src/pwa-host.js";
import { InMemoryPublicationMetadataStore } from "../src/storage/publication-metadata.js";
import { InMemoryPwaPushSubscriptionStore } from "../src/storage/pwa-push-subscriptions.js";

const pwaHost = "https://PwaHost1.artifacts.thefocus.ai";
const pwaUrl = `${pwaHost}/`;
const subscriptionJson = {
  endpoint: "https://push.example/endpoint/1",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

async function setup(options: { pwa?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const metadataStore = new InMemoryPublicationMetadataStore();
  const subscriptionStore = new InMemoryPwaPushSubscriptionStore();
  const tokenStore = new InMemoryPublisherTokenStore();
  await metadataStore.create({
    opaqueId: "PwaHost1",
    publisherEmail: "publisher@thefocus.ai",
    activeManifestRef: "manifest-1",
    activeArtifactLocator: "blob://pwa",
    pwa: options.pwa ?? true,
  });
  const issued = await issuePublisherToken({
    email: "publisher@thefocus.ai",
    store: tokenStore,
  });
  const handle = (request: Request) =>
    handlePwaPushRequest({
      request,
      metadataStore,
      subscriptionStore,
      tokenStore,
      env: options.env ?? {
        VAPID_PUBLIC_KEY: "test-vapid-public",
        VAPID_PRIVATE_KEY: "test-vapid-private",
        VAPID_SUBJECT: "mailto:artifacts@thefocus.ai",
      },
    });
  return { metadataStore, subscriptionStore, tokenStore, issued, handle };
}

describe("PWA platform push routing", () => {
  it("does not rewrite /api/push on the wildcard host", () => {
    expect(
      pwaMiddlewareRewriteUrl(
        new Request(`${pwaHost}/api/push?action=subscribe`),
      ),
    ).toBeNull();
    expect(
      pwaMiddlewareRewriteUrl(
        new Request(`${pwaHost}/api/push/vapid-public-key`),
      ),
    ).toBeNull();
    expect(
      pwaMiddlewareRewriteUrl(new Request(`${pwaHost}/sw.js`))?.pathname,
    ).toBe("/api/pwa");
  });
});

describe("PWA platform push HTTP", () => {
  it("serves the platform VAPID public key from the PWA host", async () => {
    const { handle } = await setup();
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=vapid-public-key`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      publicKey: "test-vapid-public",
    });
    const fromPath = await handle(
      new Request(`${pwaHost}/api/push/vapid-public-key`),
    );
    expect(fromPath.status).toBe(200);
  });

  it("refuses vapid and subscribe on the apex host", async () => {
    const { handle } = await setup();
    const vapid = await handle(
      new Request(
        "https://artifacts.thefocus.ai/api/push?action=vapid-public-key",
      ),
    );
    expect(vapid.status).toBe(400);
    const subscribe = await handle(
      new Request("https://artifacts.thefocus.ai/api/push?action=subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionJson),
      }),
    );
    expect(subscribe.status).toBe(400);
  });

  it("returns 503 when the public VAPID key is not configured", async () => {
    const { handle } = await setup({ env: {} });
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=vapid-public-key`),
    );
    expect(response.status).toBe(503);
  });

  it("stores a subscription keyed by the host-derived opaque id", async () => {
    const { handle, subscriptionStore } = await setup();
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "TestBrowser/1",
        },
        body: JSON.stringify({
          ...subscriptionJson,
          opaqueId: "attacker-supplied",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "subscribed",
      opaqueId: "PwaHost1",
    });
    const rows = await subscriptionStore.listByOpaqueId("PwaHost1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: subscriptionJson.endpoint,
      p256dh: "p256dh-key",
      userAgent: "TestBrowser/1",
    });
  });

  it("ignores a client-supplied opaque and rejects a non-PWA publication", async () => {
    const { handle, metadataStore } = await setup({ pwa: false });
    await metadataStore.update("PwaHost1", { pwa: false });
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionJson),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("unsubscribes by endpoint on the PWA host", async () => {
    const { handle, subscriptionStore } = await setup();
    await handle(
      new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionJson),
      }),
    );
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscriptionJson.endpoint }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(subscriptionStore.listByOpaqueId("PwaHost1")).resolves.toEqual(
      [],
    );
  });

  it("sends only for the owning Publisher and stubs fanout without a sender", async () => {
    const { handle, issued, tokenStore } = await setup();
    await handle(
      new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionJson),
      }),
    );

    const unauthenticated = await handle(
      new Request("https://artifacts.thefocus.ai/api/push?action=send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicationUrl: pwaUrl,
          title: "Hello",
          body: "World",
        }),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const other = await issuePublisherToken({
      email: "other@thefocus.ai",
      store: tokenStore,
    });
    const forbidden = await handle(
      new Request("https://artifacts.thefocus.ai/api/push?action=send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({
          publicationUrl: pwaUrl,
          title: "Hello",
          body: "World",
        }),
      }),
    );
    expect(forbidden.status).toBe(403);

    const pathHosted = await handle(
      new Request("https://artifacts.thefocus.ai/api/push?action=send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify({
          publicationUrl: "https://artifacts.thefocus.ai/a/PwaHost1",
          title: "Hello",
          body: "World",
        }),
      }),
    );
    expect(pathHosted.status).toBe(400);

    const sent = await handle(
      new Request("https://artifacts.thefocus.ai/api/push?action=send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify({
          publicationUrl: pwaUrl,
          title: "Hello",
          body: "World",
        }),
      }),
    );
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toMatchObject({
      opaqueId: "PwaHost1",
      subscriptionCount: 1,
      delivered: 0,
      implementation: "stubbed",
    });
  });

  it("fans out through an injected sender and drops 410 endpoints", async () => {
    const { metadataStore, subscriptionStore, tokenStore, issued } =
      await setup();
    await handlePwaPushRequest({
      request: new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionJson),
      }),
      metadataStore,
      subscriptionStore,
      tokenStore,
      env: {
        VAPID_PUBLIC_KEY: "test-vapid-public",
        VAPID_PRIVATE_KEY: "test-vapid-private",
        VAPID_SUBJECT: "mailto:artifacts@thefocus.ai",
      },
    });
    await subscriptionStore.upsert({
      opaqueId: "PwaHost1",
      endpoint: "https://push.example/endpoint/gone",
      p256dh: "x",
      auth: "y",
    });

    const response = await handlePwaPushRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/api/push?action=send",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${issued.token}`,
          },
          body: JSON.stringify({
            publicationUrl: pwaUrl,
            title: "Hello",
            body: "World",
          }),
        },
      ),
      metadataStore,
      subscriptionStore,
      tokenStore,
      env: {
        VAPID_PUBLIC_KEY: "test-vapid-public",
        VAPID_PRIVATE_KEY: "test-vapid-private",
        VAPID_SUBJECT: "mailto:artifacts@thefocus.ai",
      },
      sender: {
        async send({ subscription }) {
          if (subscription.endpoint.endsWith("/gone")) {
            return { endpoint: subscription.endpoint, status: "gone" };
          }
          return { endpoint: subscription.endpoint, status: "sent" };
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      implementation: "web-push",
      delivered: 1,
      gone: 1,
      subscriptionCount: 2,
    });
    const remaining = await subscriptionStore.listByOpaqueId("PwaHost1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.endpoint).toBe(subscriptionJson.endpoint);
  });

  it("rate-limits send per publisher and publication", async () => {
    const { metadataStore, subscriptionStore, tokenStore, issued } =
      await setup();
    const limited = await handlePwaPushRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/api/push?action=send",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${issued.token}`,
          },
          body: JSON.stringify({
            publicationUrl: pwaUrl,
            title: "Hello",
            body: "World",
          }),
        },
      ),
      metadataStore,
      subscriptionStore,
      tokenStore,
      rateLimiter: { consume: () => false },
    });
    expect(limited.status).toBe(429);
  });

  it("answers CORS preflight when Origin matches the PWA host", async () => {
    const { handle } = await setup();
    const response = await handle(
      new Request(`${pwaHost}/api/push?action=subscribe`, {
        method: "OPTIONS",
        headers: { origin: pwaHost },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(pwaHost);
  });
});

describe("CLI push send", () => {
  it("posts an authenticated send payload and prints the JSON result", async () => {
    let captured: { token?: string; input?: unknown } = {};
    const stdout = {
      text: "",
      write(chunk: string) {
        this.text += chunk;
        return true;
      },
    };
    const exitCode = await runCli(
      [
        "push",
        "send",
        "--url",
        pwaUrl,
        "--title",
        "Hello",
        "--body",
        "World",
        "--click-url",
        "/alerts",
      ],
      {
        env: { THEFOCUS_ARTIFACTS_TOKEN: "tfai_pub_test" },
        stdout,
        pushApiClient: {
          async send(token, input) {
            captured = { token, input };
            return {
              publicationUrl: input.publicationUrl,
              opaqueId: "PwaHost1",
              title: input.title,
              body: input.body,
              url: input.url,
              subscriptionCount: 0,
              delivered: 0,
              gone: 0,
              failed: 0,
              implementation: "stubbed",
            };
          },
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(captured).toEqual({
      token: "tfai_pub_test",
      input: {
        publicationUrl: pwaUrl,
        title: "Hello",
        body: "World",
        url: "/alerts",
      },
    });
    expect(stdout.text).toContain('"implementation": "stubbed"');
  });
});
