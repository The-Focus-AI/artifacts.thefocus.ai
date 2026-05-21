import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  publishSingleFileArtifact,
  publishSingleFileArtifactWithPublisherToken,
  servePublicationRequest,
} from "../src/index.js";

describe("single-file publish/view path", () => {
  it("publishes one local HTML file and serves it at the canonical Publication URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-single-file-"));
    const htmlPath = join(dir, "client-demo.html");
    await writeFile(htmlPath, "<!doctype html><h1>Hello client</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();

    const published = await publishSingleFileArtifact({
      filePath: htmlPath,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "Ab3xY9kQ",
      manifestRef: "manifest-1",
    });

    expect(published.publicationUrlPath).toBe("/a/Ab3xY9kQ");
    expect(published.publicationUrl).toBe(
      "https://artifacts.thefocus.ai/a/Ab3xY9kQ",
    );
    await expect(
      metadataStore.getByOpaqueId("Ab3xY9kQ"),
    ).resolves.toMatchObject({
      activeManifestRef: "manifest-1",
      activeArtifactLocator:
        "memory://artifacts/Ab3xY9kQ/manifest-1/index.html",
    });

    const response = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toBe(
      "<!doctype html><h1>Hello client</h1>",
    );
  });

  it("requires a valid Publisher Token for authenticated publishing", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "artifacts-authenticated-publish-"),
    );
    const htmlPath = join(dir, "client-demo.html");
    await writeFile(htmlPath, "<!doctype html><h1>Authenticated</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store: tokenStore,
      tokenFactory: () => "tfai_pub_publish",
    });

    const published = await publishSingleFileArtifactWithPublisherToken({
      filePath: htmlPath,
      publisherToken: issued.token,
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      tokenStore,
    });

    expect(published.publicationUrl).toMatch(
      /^https:\/\/artifacts\.thefocus\.ai\/a\//,
    );
    await expect(
      metadataStore.getByOpaqueId(published.opaqueId),
    ).resolves.toMatchObject({ publisherEmail: "publisher@thefocus.ai" });
    await expect(
      publishSingleFileArtifactWithPublisherToken({
        filePath: htmlPath,
        publisherToken: "wrong",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        metadataStore,
        contentStore,
        tokenStore,
      }),
    ).rejects.toThrow("valid Publisher Token");
  });

  it("only serves canonical /a/{opaque} Publication URLs", async () => {
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();

    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/not-a-publication"),
      metadataStore,
      contentStore,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
