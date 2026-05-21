import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  publishArtifact,
  removePublication,
  servePublicationRequest,
} from "../src/index.js";

const baseInput = {
  publisherEmail: "publisher@thefocus.ai",
  publicBaseUrl: "https://artifacts.thefocus.ai",
};

async function validToken(store: InMemoryPublisherTokenStore) {
  return issuePublisherToken({
    email: "other-publisher@thefocus.ai",
    store,
    tokenFactory: () => "tfai_pub_remove",
  });
}

describe("Publication Removal", () => {
  it("removes an active single-file Publication, deletes its Blob content, marks metadata removed, and clears matching local state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-remove-single-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>remove me</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const token = await validToken(tokenStore);

    const published = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "RemoveOne",
      manifestRefFactory: () => "manifest-1",
      now: () => new Date("2026-05-21T12:00:00.000Z"),
    });

    const result = await removePublication({
      publicationUrl: published.publicationUrl,
      publisherToken: token.token,
      metadataStore,
      contentStore,
      tokenStore,
      stateStore,
    });

    expect(result).toMatchObject({
      opaqueId: "RemoveOne",
      status: "removed",
      deletedLocators: ["memory://artifacts/RemoveOne/manifest-1/index.html"],
      clearedLocalSourcePath: await realpath(sourcePath),
    });
    await expect(
      metadataStore.getByOpaqueId("RemoveOne"),
    ).resolves.toMatchObject({
      status: "removed",
    });
    await expect(
      contentStore.read(result.deletedLocators[0]!),
    ).resolves.toBeNull();
    await expect(
      stateStore.get(await realpath(sourcePath)),
    ).resolves.toBeNull();

    const response = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });
    expect(response.status).toBe(404);
  });

  it("removes directory Artifact manifests and file locators immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-remove-dir-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    await writeFile(join(dir, "assets", "app.js"), "console.log('bye');");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const token = await validToken(tokenStore);

    const published = await publishArtifact({
      sourcePath: dir,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "RemoveDir",
      manifestRefFactory: () => "manifest-dir",
    });

    const result = await removePublication({
      publicationUrl: published.publicationUrl,
      publisherToken: token.token,
      metadataStore,
      contentStore,
      tokenStore,
      stateStore,
    });

    expect(result.deletedLocators.sort()).toEqual([
      "memory://artifacts/RemoveDir/manifest-dir/assets/app.js",
      "memory://artifacts/RemoveDir/manifest-dir/index.html",
      "memory://artifacts/RemoveDir/manifest-dir/manifest.json",
    ]);
    for (const locator of result.deletedLocators) {
      await expect(contentStore.read(locator)).resolves.toBeNull();
    }
  });

  it("requires authentication but allows any valid Publisher Token to remove a Publication URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-remove-auth-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>owned by someone else</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const token = await validToken(tokenStore);

    const published = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "TeamRemove",
      manifestRefFactory: () => "manifest-1",
    });

    await expect(
      removePublication({
        publicationUrl: published.publicationUrl,
        publisherToken: "wrong",
        metadataStore,
        contentStore,
        tokenStore,
        stateStore,
      }),
    ).rejects.toThrow("valid Publisher Token");

    await expect(
      removePublication({
        publicationUrl: published.publicationUrl,
        publisherToken: token.token,
        metadataStore,
        contentStore,
        tokenStore,
        stateStore,
      }),
    ).resolves.toMatchObject({ status: "removed" });
  });

  it("treats unknown and already removed Publication URLs as not found", async () => {
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const token = await validToken(tokenStore);

    await expect(
      removePublication({
        publicationUrl: "https://artifacts.thefocus.ai/a/Missing",
        publisherToken: token.token,
        metadataStore,
        contentStore,
        tokenStore,
        stateStore,
      }),
    ).resolves.toMatchObject({ status: "not-found", deletedLocators: [] });
  });
});
