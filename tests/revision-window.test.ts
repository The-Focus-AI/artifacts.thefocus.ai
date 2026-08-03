import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  publishArtifact,
  servePublicationRequest,
} from "../src/index.js";

const baseInput = {
  publisherEmail: "publisher@thefocus.ai",
  publicBaseUrl: "https://artifacts.thefocus.ai",
};

describe("Revision Window publishing decisions", () => {
  it("creates local state, updates the same Publication inside the rolling 15-minute Revision Window, and extends it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-revision-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>first</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    const first = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "SameUrl",
      manifestRefFactory: () => "manifest-1",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });

    expect(first.decision).toBe("created");
    expect(first.publicationUrl).toBe(
      "https://artifacts.thefocus.ai/a/SameUrl/",
    );
    expect(first.revisionWindowExpiresAt.toISOString()).toBe(
      "2026-05-20T12:15:00.000Z",
    );
    await expect(
      stateStore.get(await realpath(sourcePath)),
    ).resolves.toMatchObject({
      opaqueId: "SameUrl",
      revisionWindowExpiresAt: new Date("2026-05-20T12:15:00.000Z"),
    });

    await writeFile(sourcePath, "<h1>hotfix</h1>");
    const second = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => {
        throw new Error("plain publish inside Revision Window must not create");
      },
      manifestRefFactory: () => "manifest-2",
      now: () => new Date("2026-05-20T12:10:00.000Z"),
    });

    expect(second.decision).toBe("updated");
    expect(second.opaqueId).toBe("SameUrl");
    expect(second.revisionWindowExpiresAt.toISOString()).toBe(
      "2026-05-20T12:25:00.000Z",
    );

    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/SameUrl/"),
      metadataStore,
      contentStore,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<h1>hotfix</h1>");
  });

  it("creates a fresh Publication after expiry and when --new is requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-revision-new-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>first</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const opaqueIds = ["OldUrl", "ExpiredUrl", "ForcedUrl"];

    await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => opaqueIds.shift()!,
      manifestRefFactory: () => "manifest-old",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });

    const expired = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => opaqueIds.shift()!,
      manifestRefFactory: () => "manifest-expired",
      now: () => new Date("2026-05-20T12:16:00.000Z"),
    });
    expect(expired).toMatchObject({
      opaqueId: "ExpiredUrl",
      decision: "created-after-expiry",
    });

    const forced = await publishArtifact({
      sourcePath,
      forceNew: true,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => opaqueIds.shift()!,
      manifestRefFactory: () => "manifest-forced",
      now: () => new Date("2026-05-20T12:17:00.000Z"),
    });
    expect(forced).toMatchObject({
      opaqueId: "ForcedUrl",
      decision: "forced-new",
    });
    await expect(
      stateStore.get(await realpath(sourcePath)),
    ).resolves.toMatchObject({
      opaqueId: "ForcedUrl",
    });
  });

  it("explicitly updates a Publication URL and starts a fresh Revision Window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-explicit-update-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>first</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "TargetUrl",
      manifestRefFactory: () => "manifest-1",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });
    await writeFile(sourcePath, "<h1>explicit update</h1>");

    const updated = await publishArtifact({
      sourcePath,
      updatePublicationUrl: "https://artifacts.thefocus.ai/a/TargetUrl",
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      manifestRefFactory: () => "manifest-2",
      now: () => new Date("2026-05-20T13:00:00.000Z"),
    });

    expect(updated).toMatchObject({
      opaqueId: "TargetUrl",
      decision: "explicit-update",
    });
    expect(updated.revisionWindowExpiresAt.toISOString()).toBe(
      "2026-05-20T13:15:00.000Z",
    );
    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/TargetUrl/"),
      metadataStore,
      contentStore,
    });
    await expect(response.text()).resolves.toBe("<h1>explicit update</h1>");
  });

  it("falls back to a new Publication when local state points to a removed Publication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-removed-fallback-"));
    const sourcePath = join(dir, "client-demo.html");
    await writeFile(sourcePath, "<h1>first</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "RemovedUrl",
      manifestRefFactory: () => "manifest-1",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });
    await metadataStore.markRemoved("RemovedUrl");

    const republished = await publishArtifact({
      sourcePath,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "ReplacementUrl",
      manifestRefFactory: () => "manifest-2",
      now: () => new Date("2026-05-20T12:05:00.000Z"),
    });

    expect(republished).toMatchObject({
      opaqueId: "ReplacementUrl",
      decision: "created-after-removed-local-state",
    });
  });

  it("mirrors directory updates and deletes old Blob contents after the active manifest switches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-directory-mirror-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<h1>first</h1>");
    await writeFile(join(dir, "assets", "old.js"), "old");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    await publishArtifact({
      sourcePath: dir,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "MirrorUrl",
      manifestRefFactory: () => "manifest-1",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });
    await writeFile(join(dir, "index.html"), "<h1>second</h1>");
    await rm(join(dir, "assets", "old.js"));
    await writeFile(join(dir, "assets", "new.js"), "new");

    const updated = await publishArtifact({
      sourcePath: dir,
      ...baseInput,
      metadataStore,
      contentStore,
      stateStore,
      manifestRefFactory: () => "manifest-2",
      now: () => new Date("2026-05-20T12:05:00.000Z"),
    });

    expect(updated.decision).toBe("updated");
    await expect(
      contentStore.read(
        "memory://artifacts/MirrorUrl/manifest-1/manifest.json",
      ),
    ).resolves.toBeNull();
    await expect(
      contentStore.read(
        "memory://artifacts/MirrorUrl/manifest-1/assets/old.js",
      ),
    ).resolves.toBeNull();

    const oldAsset = await servePublicationRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/a/MirrorUrl/assets/old.js",
      ),
      metadataStore,
      contentStore,
    });
    expect(oldAsset.status).toBe(404);
    const newAsset = await servePublicationRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/a/MirrorUrl/assets/new.js",
      ),
      metadataStore,
      contentStore,
    });
    expect(newAsset.status).toBe(200);
  });
});
