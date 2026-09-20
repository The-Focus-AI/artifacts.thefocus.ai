import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { publicationRequestUrl } from "../src/http.js";
import { InMemoryPublicationStateStore } from "../src/local-config.js";
import {
  publishArtifact,
  servePublicationRequest,
} from "../src/publication.js";
import {
  assertPwaBundle,
  isDnsSafeOpaqueId,
  isPwaWildcardHost,
  publicationShareUrl,
  pwaMiddlewareRewriteUrl,
  pwaPublicationUrl,
  pwaRouteFromUrl,
} from "../src/pwa-host.js";
import { InMemoryArtifactContentStore } from "../src/storage/artifact-content.js";
import { InMemoryPublicationMetadataStore } from "../src/storage/publication-metadata.js";

async function writeMinimalPwa(directory: string): Promise<void> {
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><h1>PWA</h1><script>navigator.serviceWorker.register("/sw.js")</script></body></html>',
  );
  await writeFile(
    join(directory, "manifest.webmanifest"),
    JSON.stringify({
      name: "Demo PWA",
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    }),
  );
  await writeFile(
    join(directory, "sw.js"),
    "self.addEventListener('fetch',()=>{});",
  );
  await writeFile(
    join(directory, "icon-192.png"),
    Buffer.from([137, 80, 78, 71]),
  );
}

describe("PWA host routing", () => {
  it("parses the wildcard origin root and nested Artifact Paths", () => {
    expect(pwaRouteFromUrl("https://Ab3xY9kQ.artifacts.thefocus.ai/")).toEqual({
      opaqueId: "ab3xy9kq",
      artifactPath: "",
    });
    expect(
      pwaRouteFromUrl("https://Ab3xY9kQ.artifacts.thefocus.ai/sw.js"),
    ).toEqual({
      opaqueId: "ab3xy9kq",
      artifactPath: "sw.js",
    });
    expect(pwaRouteFromUrl("https://artifacts.thefocus.ai/a/Ab3xY9kQ")).toBe(
      null,
    );
    expect(isPwaWildcardHost("Ab3xY9kQ.artifacts.thefocus.ai")).toBe(true);
    expect(isPwaWildcardHost("artifacts.thefocus.ai")).toBe(false);
    expect(isPwaWildcardHost("www.artifacts.thefocus.ai")).toBe(false);
  });

  it("builds the PWA share URL at the origin root", () => {
    expect(pwaPublicationUrl("https://artifacts.thefocus.ai", "Ab3xY9kQ")).toBe(
      "https://Ab3xY9kQ.artifacts.thefocus.ai/",
    );
    expect(
      publicationShareUrl("https://artifacts.thefocus.ai", {
        opaqueId: "Ab3xY9kQ",
        publicationUrlPath: "/a/Ab3xY9kQ",
        pwa: true,
      }),
    ).toBe("https://Ab3xY9kQ.artifacts.thefocus.ai/");
    expect(
      publicationShareUrl("https://artifacts.thefocus.ai", {
        opaqueId: "Ab3xY9kQ",
        publicationUrlPath: "/a/Ab3xY9kQ",
        pwa: false,
      }),
    ).toBe("https://artifacts.thefocus.ai/a/Ab3xY9kQ");
  });

  it("rewrites wildcard-host requests to /api/pwa before static files", () => {
    const destination = pwaMiddlewareRewriteUrl(
      new Request("https://Ab3xY9kQ.artifacts.thefocus.ai/sw.js"),
    );
    expect(destination?.pathname).toBe("/api/pwa");
    expect(destination?.searchParams.get("path")).toBe("sw.js");
    expect(
      pwaMiddlewareRewriteUrl(new Request("https://artifacts.thefocus.ai/")),
    ).toBeNull();
    expect(
      pwaMiddlewareRewriteUrl(
        new Request(
          "https://Ab3xY9kQ.artifacts.thefocus.ai/api/pwa?path=sw.js",
        ),
      ),
    ).toBeNull();
  });

  it("maps Vercel PWA function requests back to the wildcard origin URL", () => {
    const request = {
      url: "/api/pwa",
      headers: {
        host: "Ab3xY9kQ.artifacts.thefocus.ai",
        "x-forwarded-proto": "https",
      },
      query: { path: "manifest.webmanifest" },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://Ab3xY9kQ.artifacts.thefocus.ai/manifest.webmanifest",
    );
  });
});

describe("PWA publish and serve", () => {
  it("publishes --pwa to the wildcard root and serves / plus nested PWA files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-pwa-"));
    await writeMinimalPwa(dir);
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    const published = await publishArtifact({
      sourcePath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      stateStore,
      pwa: true,
      opaqueIdFactory: () => "PwaHost1",
    });

    expect(published.publicationUrl).toBe(
      "https://PwaHost1.artifacts.thefocus.ai/",
    );
    expect(published.publicationUrlPath).toBe("/a/PwaHost1");
    await expect(
      metadataStore.getByOpaqueId("PwaHost1"),
    ).resolves.toMatchObject({
      pwa: true,
    });

    const home = await servePublicationRequest({
      request: new Request("https://PwaHost1.artifacts.thefocus.ai/"),
      metadataStore,
      contentStore,
    });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    expect(home.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(home.text()).resolves.toContain("<h1>PWA</h1>");

    const manifest = await servePublicationRequest({
      request: new Request(
        "https://PwaHost1.artifacts.thefocus.ai/manifest.webmanifest",
      ),
      metadataStore,
      contentStore,
    });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    expect(manifest.headers.get("cache-control")).toBe("no-cache");

    const worker = await servePublicationRequest({
      request: new Request("https://PwaHost1.artifacts.thefocus.ai/sw.js"),
      metadataStore,
      contentStore,
    });
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toContain("text/javascript");
    expect(worker.headers.get("service-worker-allowed")).toBe("/");
    expect(worker.headers.get("cache-control")).toBe("no-cache");

    const pathHosted = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/PwaHost1/sw.js"),
      metadataStore,
      contentStore,
    });
    expect(pathHosted.status).toBe(200);
    expect(pathHosted.headers.get("cache-control")).toBe("no-store");
    expect(pathHosted.headers.get("service-worker-allowed")).toBeNull();
  });

  it("keeps ordinary Publications on /a/ and rejects incomplete PWA bundles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-pwa-reject-"));
    await writeFile(join(dir, "index.html"), "<h1>Just a page</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();

    const published = await publishArtifact({
      sourcePath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      stateStore,
      opaqueIdFactory: () => "NotAPwa",
    });
    expect(published.publicationUrl).toBe(
      "https://artifacts.thefocus.ai/a/NotAPwa",
    );

    await expect(
      publishArtifact({
        sourcePath: dir,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        metadataStore,
        contentStore,
        stateStore,
        pwa: true,
        forceNew: true,
      }),
    ).rejects.toThrow(/manifest\.webmanifest/);

    expect(() =>
      assertPwaBundle([{ artifactPath: "index.html", body: "<h1>x</h1>" }]),
    ).toThrow(/manifest/);
    expect(isDnsSafeOpaqueId("Ab3xY9kQ")).toBe(true);
    expect(isDnsSafeOpaqueId("has_underscore")).toBe(false);
  });
});
