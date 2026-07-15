import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  publishSingleFileArtifact,
  servePublicationRequest,
} from "../src/index.js";

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("minimal landing page", () => {
  it("is TheFocus.AI branded and links to the main site", async () => {
    const html = await readProjectFile("public/landing.html");

    expect(html).toContain("TheFocus.AI");
    expect(html).toContain("Artifacts");
    expect(html).toContain('href="https://thefocus.ai/"');
    expect(html).not.toContain('name="robots" content="noindex');
  });

  it("does not expose a public Publication listing", async () => {
    const html = await readProjectFile("public/landing.html");
    const vercelConfig = JSON.parse(await readProjectFile("vercel.json")) as {
      rewrites?: Array<{ source: string; destination: string }>;
    };

    expect(html).not.toMatch(
      /Publication listing|Recent Publications|<ul[^>]*id="?publications/i,
    );
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/a/:opaque",
      destination: "/api/a/:opaque",
    });
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/a/:opaque/",
      destination: "/api/a/:opaque",
    });
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/a/:opaque/:path*",
      destination: "/api/a/:opaque?path=:path*",
    });
  });
});

describe("agent readiness discovery resources", () => {
  it("publishes a concise llms.txt with service resources and no Publication listing", async () => {
    const llms = await readProjectFile("public/llms.txt");

    expect(llms).toContain("# TheFocus.AI Artifacts");
    expect(llms).toContain("Dynamic publishing skill for AI agents");
    expect(llms).toContain(
      "npx @the-focus-ai/artifacts publish ./artifact.html",
    );
    expect(llms).toContain("https://artifacts.thefocus.ai/index.md");
    expect(llms).toContain("https://artifacts.thefocus.ai/sitemap.xml");
    expect(llms).not.toMatch(
      /https:\/\/artifacts\.thefocus\.ai\/a\/[A-Za-z0-9]{9,}/,
    );
  });

  it("publishes a Markdown representation of the root landing page", async () => {
    const markdown = await readProjectFile("public/index.md");

    expect(markdown).toContain("# Publish agent-created HTML");
    expect(markdown).toContain(
      "npx @the-focus-ai/artifacts publish ./artifact.html",
    );
  });

  it("publishes a sitemap for root service resources only", async () => {
    const sitemap = await readProjectFile("public/sitemap.xml");

    expect(sitemap).toContain("<loc>https://artifacts.thefocus.ai/</loc>");
    expect(sitemap).toContain(
      "<loc>https://artifacts.thefocus.ai/llms.txt</loc>",
    );
    expect(sitemap).not.toContain("https://artifacts.thefocus.ai/a/");
  });

  it("advertises agent resources and Markdown negotiation in Vercel config", async () => {
    const vercelConfig = JSON.parse(await readProjectFile("vercel.json")) as {
      headers?: Array<{
        source: string;
        headers: Array<{ key: string; value: string }>;
      }>;
      rewrites?: Array<{
        source: string;
        destination: string;
        has?: Array<{ type: string; key: string; value: string }>;
      }>;
    };

    expect(vercelConfig.headers).toContainEqual({
      source: "/",
      headers: [
        {
          key: "Link",
          value:
            '</sitemap.xml>; rel="sitemap"; type="application/xml", </llms.txt>; rel="alternate"; type="text/plain", </index.md>; rel="alternate"; type="text/markdown"',
        },
        {
          key: "Content-Signal",
          value: "ai-train=no, search=yes, ai-input=yes",
        },
        {
          key: "Vary",
          value: "Accept",
        },
      ],
    });

    // The root must be served by the negotiation function, not the static
    // filesystem (which would shadow negotiation) and not header-conditional
    // rewrites (whose `has` matching proved unreliable in production).
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/",
      destination: "/api/root",
    });
  });

  it("negotiates the root response by Accept header", async () => {
    const { default: handler, wantsMarkdown } = await import("../api/root.js");

    expect(wantsMarkdown("text/markdown")).toBe(true);
    expect(wantsMarkdown("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(
      false,
    );
    expect(wantsMarkdown(undefined)).toBe(false);

    async function invoke(accept?: string) {
      const headers: Record<string, string> = {};
      let body = "";
      const response = {
        statusCode: 0,
        setHeader(key: string, value: string) {
          headers[key.toLowerCase()] = value;
        },
        end(chunk: Buffer) {
          body = chunk.toString("utf8");
        },
      };
      await handler(
        { headers: accept ? { accept } : {} } as never,
        response as never,
      );
      return { headers, body };
    }

    const agent = await invoke("text/markdown");
    expect(agent.headers["content-type"]).toContain("text/markdown");
    expect(agent.headers["vary"]).toBe("Accept");
    expect(agent.body).toContain("# Publish agent-created HTML");

    const browser = await invoke("text/html,*/*;q=0.8");
    expect(browser.headers["content-type"]).toContain("text/html");
    expect(browser.body).toContain("TheFocus.AI");
  });
});

describe("robots and Publication indexing posture", () => {
  it("disallows crawling Publication URLs and publishes agent usage policy", async () => {
    await expect(readProjectFile("public/robots.txt")).resolves.toContain(
      "Disallow: /a/",
    );
    await expect(readProjectFile("public/robots.txt")).resolves.toContain(
      "Content-Signal: ai-train=no, search=yes, ai-input=yes",
    );
    await expect(readProjectFile("public/robots.txt")).resolves.toContain(
      "Sitemap: https://artifacts.thefocus.ai/sitemap.xml",
    );
  });

  it("serves Publication responses with noindex headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-noindex-"));
    const htmlPath = join(dir, "index.html");
    await writeFile(htmlPath, "<!doctype html><h1>Noindex</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    const published = await publishSingleFileArtifact({
      filePath: htmlPath,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "NoIndex1",
      manifestRef: "manifest-1",
    });

    const response = await servePublicationRequest({
      request: new Request(published.publicationUrl),
      metadataStore,
      contentStore,
    });

    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("publishing API CORS posture", () => {
  it("does not expose public CORS headers", async () => {
    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/Anything", {
        headers: { origin: "https://example.com" },
      }),
      metadataStore: new InMemoryPublicationMetadataStore(),
      contentStore: new InMemoryArtifactContentStore(),
    });

    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-allow-methods")).toBe(false);
    expect(response.headers.has("access-control-allow-headers")).toBe(false);
  });

  it("does not implement CORS preflight for Publication APIs", async () => {
    const response = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/Anything", {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "PUT",
        },
      }),
      metadataStore: new InMemoryPublicationMetadataStore(),
      contentStore: new InMemoryArtifactContentStore(),
    });

    expect(response.status).toBe(405);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});
