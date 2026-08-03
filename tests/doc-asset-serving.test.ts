import { describe, expect, it } from "vitest";

import {
  InMemoryDocAssetContentStore,
  InMemoryLivingDocMetadataStore,
  livingDocAssetUrl,
  livingDocViewRouteFromUrl,
  normalizeDocAssetPath,
  publishLivingDoc,
  serveLivingDocViewRequest,
} from "../src/index.js";

const publisherEmail = "publisher@thefocus.ai";
const publicBaseUrl = "https://artifacts.thefocus.ai";

async function publishDoc(
  store: InMemoryLivingDocMetadataStore,
  markdown = "# Hello\n",
) {
  return publishLivingDoc({
    markdown,
    publisherEmail,
    publicBaseUrl,
    store,
    opaqueId: "docOpaque1",
    reviewId: "reviewSecret1",
  });
}

describe("Doc Asset path helpers", () => {
  it("normalizes hosted asset paths and rejects traversal", () => {
    expect(normalizeDocAssetPath("assets/a.jpg")).toBe("assets/a.jpg");
    expect(normalizeDocAssetPath("/assets/a.jpg")).toBe("assets/a.jpg");
    expect(normalizeDocAssetPath("assets/../secret.jpg")).toBeNull();
    expect(normalizeDocAssetPath("")).toBeNull();
    expect(normalizeDocAssetPath("..")).toBeNull();
  });

  it("parses view routes with and without asset paths", () => {
    expect(
      livingDocViewRouteFromUrl("https://artifacts.thefocus.ai/d/abc"),
    ).toEqual({ opaqueId: "abc", assetPath: "" });
    expect(
      livingDocViewRouteFromUrl(
        "https://artifacts.thefocus.ai/d/abc/assets/card.jpg",
      ),
    ).toEqual({ opaqueId: "abc", assetPath: "assets/card.jpg" });
    expect(livingDocAssetUrl(publicBaseUrl, "abc", "assets/card.jpg")).toBe(
      "https://artifacts.thefocus.ai/d/abc/assets/card.jpg",
    );
  });
});

describe("Doc Asset serving", () => {
  it("serves a seeded Doc Asset under the View prefix", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    await publishDoc(store);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await contentStore.write({
      opaqueId: "docOpaque1",
      assetPath: "assets/card.png",
      body: png,
      contentType: "image/png",
    });

    const response = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/docOpaque1/assets/card.png",
      ),
      store,
      contentStore,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("keeps /d/{opaqueId}/ as the HTML View and redirects the bare form to it", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    await publishDoc(store, "# Title\n\nBody");

    const bare = await serveLivingDocViewRequest({
      request: new Request("https://artifacts.thefocus.ai/d/docOpaque1"),
      store,
      contentStore,
    });
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("/d/docOpaque1/");

    const response = await serveLivingDocViewRequest({
      request: new Request("https://artifacts.thefocus.ai/d/docOpaque1/"),
      store,
      contentStore,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<h1>Title</h1>");
    expect(html).not.toContain("image/png");
  });

  it("returns 404 for missing assets, unknown docs, and removed docs", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    await publishDoc(store);
    await contentStore.write({
      opaqueId: "docOpaque1",
      assetPath: "assets/card.png",
      body: Buffer.from("x"),
    });

    const missing = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/docOpaque1/assets/missing.png",
      ),
      store,
      contentStore,
    });
    expect(missing.status).toBe(404);

    const unknown = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/nope/assets/card.png",
      ),
      store,
      contentStore,
    });
    expect(unknown.status).toBe(404);

    await store.markRemoved("docOpaque1");
    const removed = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/docOpaque1/assets/card.png",
      ),
      store,
      contentStore,
    });
    expect(removed.status).toBe(404);
  });

  it("rejects path traversal in asset URLs", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    await publishDoc(store);
    await contentStore.write({
      opaqueId: "docOpaque1",
      assetPath: "assets/card.png",
      body: Buffer.from("x"),
    });

    const response = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/docOpaque1/assets/../card.png",
      ),
      store,
      contentStore,
    });
    expect(response.status).toBe(404);
  });
});
