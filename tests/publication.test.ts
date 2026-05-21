import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  publishDirectoryArtifact,
  publishSingleFileArtifact,
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

describe("directory publish/view path", () => {
  it("publishes a directory with a root index.html Entry Page and serves nested Artifact Paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-directory-"));
    await mkdir(join(dir, "assets"));
    await mkdir(join(dir, "about"));
    await writeFile(join(dir, "index.html"), "<!doctype html><h1>Home</h1>");
    await writeFile(join(dir, "assets", "app.js"), "console.log('ok');");
    await writeFile(join(dir, "about", "index.html"), "<h1>About</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();

    const published = await publishDirectoryArtifact({
      directoryPath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "Dir123",
      manifestRef: "manifest-dir-1",
    });

    expect(published.publicationUrl).toBe(
      "https://artifacts.thefocus.ai/a/Dir123",
    );
    expect(published.entryArtifactPath).toBe("index.html");
    expect(published.artifactPaths.sort()).toEqual([
      "about/index.html",
      "assets/app.js",
      "index.html",
    ]);

    const home = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/Dir123"),
      metadataStore,
      contentStore,
    });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.has("content-security-policy")).toBe(false);
    await expect(home.text()).resolves.toBe("<!doctype html><h1>Home</h1>");

    const asset = await servePublicationRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/a/Dir123/assets/app.js",
      ),
      metadataStore,
      contentStore,
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    await expect(asset.text()).resolves.toBe("console.log('ok');");

    const nestedIndex = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/Dir123/about/"),
      metadataStore,
      contentStore,
    });
    expect(nestedIndex.status).toBe(200);
    await expect(nestedIndex.text()).resolves.toBe("<h1>About</h1>");
  });

  it("requires a root index.html by default and supports an explicit HTML Entry Page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-entry-page-"));
    await writeFile(join(dir, "demo.html"), "<h1>Demo</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();

    await expect(
      publishDirectoryArtifact({
        directoryPath: dir,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        metadataStore,
        contentStore,
      }),
    ).rejects.toThrow(/Directory Artifacts require a root index\.html/);

    const published = await publishDirectoryArtifact({
      directoryPath: dir,
      entryPage: "demo.html",
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "Demo123",
      manifestRef: "manifest-demo",
    });

    expect(published.entryArtifactPath).toBe("demo.html");
    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/Demo123"),
      metadataStore,
      contentStore,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<h1>Demo</h1>");
  });

  it("returns 404 for missing paths and never exposes directory listings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-no-listing-"));
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    await writeFile(join(dir, "docs", "guide.html"), "<h1>Guide</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();

    await publishDirectoryArtifact({
      directoryPath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "NoList",
      manifestRef: "manifest-no-list",
    });

    for (const path of ["/missing.html", "/docs/"]) {
      const response = await servePublicationRequest({
        request: new Request(`https://artifacts.thefocus.ai/a/NoList${path}`),
        metadataStore,
        contentStore,
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
});
