import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  InMemoryPublisherTokenStore,
  authenticatePublisherToken,
  issuePublisherToken,
  publishArtifact,
  removePublication,
  servePublicationRequest,
} from "../src/index.js";

const publicBaseUrl = "https://artifacts.thefocus.ai";

describe("v1 end-to-end smoke flow", () => {
  it("logs in a test Publisher, publishes, views, hotfixes, lists, removes, and returns 404 after Removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-e2e-smoke-"));
    await mkdir(join(dir, "assets"));
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><h1>Smoke v1</h1>",
    );
    await writeFile(join(dir, "assets", "app.js"), "console.log('v1');");

    const tokenStore = new InMemoryPublisherTokenStore();
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    const login = await issuePublisherToken({
      email: "smoke.publisher@thefocus.ai",
      store: tokenStore,
      tokenFactory: () => "tfai_pub_smoke_test",
      now: () => new Date("2026-05-21T10:00:00.000Z"),
    });
    await expect(
      authenticatePublisherToken({ token: login.token, store: tokenStore }),
    ).resolves.toBe("smoke.publisher@thefocus.ai");

    const published = await publishArtifact({
      sourcePath: dir,
      publisherEmail: login.publisherEmail,
      publicBaseUrl,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "SmokeUrl",
      manifestRefFactory: () => "manifest-v1",
      now: () => new Date("2026-05-21T10:01:00.000Z"),
    });

    expect(published).toMatchObject({
      decision: "created",
      publicationUrl: "https://artifacts.thefocus.ai/a/SmokeUrl/",
    });

    const firstView = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });
    expect(firstView.status).toBe(200);
    expect(firstView.headers.get("cache-control")).toBe("no-store");
    expect(firstView.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(firstView.text()).resolves.toBe(
      "<!doctype html><h1>Smoke v1</h1>",
    );

    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><h1>Smoke hotfix</h1>",
    );
    await writeFile(join(dir, "assets", "app.js"), "console.log('hotfix');");

    const hotfix = await publishArtifact({
      sourcePath: dir,
      publisherEmail: login.publisherEmail,
      publicBaseUrl,
      metadataStore,
      contentStore,
      stateStore,
      manifestRefFactory: () => "manifest-v2",
      now: () => new Date("2026-05-21T10:05:00.000Z"),
    });
    expect(hotfix).toMatchObject({
      decision: "updated",
      publicationUrl: published.publicationUrl,
    });

    const hotfixView = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });
    expect(hotfixView.status).toBe(200);
    await expect(hotfixView.text()).resolves.toBe(
      "<!doctype html><h1>Smoke hotfix</h1>",
    );

    await expect(
      metadataStore.listByPublisherEmail(login.publisherEmail),
    ).resolves.toMatchObject([
      {
        opaqueId: "SmokeUrl",
        status: "active",
        publisherEmail: "smoke.publisher@thefocus.ai",
      },
    ]);

    const removed = await removePublication({
      publicationUrl: published.publicationUrl,
      publisherToken: login.token,
      metadataStore,
      contentStore,
      tokenStore,
      stateStore,
    });
    expect(removed).toMatchObject({
      opaqueId: "SmokeUrl",
      status: "removed",
    });
    expect(removed.deletedLocators.sort()).toEqual([
      "memory://artifacts/SmokeUrl/manifest-v2/assets/app.js",
      "memory://artifacts/SmokeUrl/manifest-v2/index.html",
      "memory://artifacts/SmokeUrl/manifest-v2/manifest.json",
    ]);

    const removedView = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });
    expect(removedView.status).toBe(404);
  });
});
