import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectDocAssets,
  handleLivingDocAgentApiRequest,
  InMemoryDocAssetContentStore,
  InMemoryLivingDocMetadataStore,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  publishLivingDoc,
  rewriteDocAssetMarkdown,
  serveLivingDocViewRequest,
  toHostedAssetPath,
} from "../src/index.js";

describe("Doc Asset collect + rewrite", () => {
  it("collects relative images and encodes parent segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-assets-"));
    const posts = join(root, "posts");
    const assets = join(root, "assets");
    await mkdir(posts);
    await mkdir(assets);
    const mdPath = join(posts, "note.md");
    const imagePath = join(assets, "dot.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    await writeFile(
      mdPath,
      "# Hi\n\n![dot](../assets/dot.png)\n\nAlso https://example.com/x.png\n",
    );

    const collected = await collectDocAssets({
      markdown: await import("node:fs/promises").then((fs) =>
        fs.readFile(mdPath, "utf-8"),
      ),
      markdownPath: mdPath,
    });

    expect(collected.missing).toEqual([]);
    expect(collected.assets).toHaveLength(1);
    expect(collected.assets[0]?.assetPath).toBe("__parent__/assets/dot.png");
    expect(toHostedAssetPath(posts, imagePath)).toBe(
      "__parent__/assets/dot.png",
    );
  });

  it("fails on missing files unless force", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-assets-missing-"));
    const mdPath = join(root, "note.md");
    await writeFile(mdPath, "![x](./gone.png)\n");
    await expect(
      collectDocAssets({
        markdown: "![x](./gone.png)\n",
        markdownPath: mdPath,
      }),
    ).rejects.toThrow(/Missing Doc Asset/);

    const forced = await collectDocAssets({
      markdown: "![x](./gone.png)\n",
      markdownPath: mdPath,
      force: true,
    });
    expect(forced.assets).toEqual([]);
    expect(forced.missing).toEqual(["./gone.png"]);
  });

  it("rewrites only mapped image refs", () => {
    const out = rewriteDocAssetMarkdown(
      "![a](./a.png) and ![b](https://ex.com/b.png) and [link](./a.png)",
      new Map([["./a.png", "https://host/d/id/a.png"]]),
    );
    expect(out).toContain("![a](https://host/d/id/a.png)");
    expect(out).toContain("![b](https://ex.com/b.png)");
    expect(out).toContain("[link](./a.png)");
  });
});

describe("Doc Asset publish end-to-end", () => {
  it("uploads assets, rewrites markdown, and serves the image", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const published = await publishLivingDoc({
      markdown: "# Card\n\n![dot](./assets/dot.png)\n",
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      store,
      contentStore,
      opaqueId: "pubDoc1",
      reviewId: "pubReview1",
      assets: [
        {
          relativeRef: "./assets/dot.png",
          assetPath: "assets/dot.png",
          contentType: "image/png",
          data: png,
        },
      ],
    });

    expect(published.uploadedAssets).toEqual(["assets/dot.png"]);
    const doc = await store.getByOpaqueId("pubDoc1");
    expect(doc?.currentMarkdown).toContain(
      "https://artifacts.thefocus.ai/d/pubDoc1/assets/dot.png",
    );
    expect(doc?.currentMarkdown).not.toContain("./assets/dot.png");

    const asset = await serveLivingDocViewRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/d/pubDoc1/assets/dot.png",
      ),
      store,
      contentStore,
    });
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(png);

    const view = await serveLivingDocViewRequest({
      request: new Request("https://artifacts.thefocus.ai/d/pubDoc1"),
      store,
      contentStore,
    });
    const html = await view.text();
    expect(html).toContain(
      "https://artifacts.thefocus.ai/d/pubDoc1/assets/dot.png",
    );
  });

  it("publishes assets over the agent API", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    const tokenStore = new InMemoryPublisherTokenStore();
    const { token } = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store: tokenStore,
    });

    const response = await handleLivingDocAgentApiRequest({
      request: new Request("https://x/api/doc?action=publish", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          markdown: "![dot](./dot.png)\n",
          assets: [
            {
              relativeRef: "./dot.png",
              assetPath: "dot.png",
              contentType: "image/png",
              data: Buffer.from("png").toString("base64"),
            },
          ],
        }),
      }),
      store,
      tokenStore,
      contentStore,
      publicBaseUrl: "https://artifacts.thefocus.ai",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      opaqueId: string;
      uploadedAssets: string[];
      viewUrl: string;
    };
    expect(body.uploadedAssets).toEqual(["dot.png"]);
    const doc = await store.getByOpaqueId(body.opaqueId);
    expect(doc?.currentMarkdown).toContain(`/d/${body.opaqueId}/dot.png`);
  });
});
