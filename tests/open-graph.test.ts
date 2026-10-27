import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  extractHtmlMetaDescription,
  injectOpenGraphTags,
  publishArtifact,
  publishDirectoryArtifact,
  publishSingleFileArtifact,
  servePublicationRequest,
} from "../src/index.js";

const card = {
  url: "https://artifacts.thefocus.ai/a/Ab3xY9kQ",
  siteName: "artifacts.thefocus.ai",
};

describe("Open Graph tag injection", () => {
  it("adds a full card before </head> using the page title and description", () => {
    const html = [
      "<!doctype html><html><head><meta charset=utf-8>",
      "<title>Q2 Results</title>",
      '<meta name="description" content="Revenue &amp; margin by region">',
      "</head><body><h1>Q2</h1></body></html>",
    ].join("");

    const injected = injectOpenGraphTags(html, { title: null, ...card });

    expect(injected).toContain(
      '<meta property="og:title" content="Q2 Results" />',
    );
    expect(injected).toContain(
      '<meta property="og:description" content="Revenue &amp; margin by region" />',
    );
    expect(injected).toContain(
      '<meta property="og:url" content="https://artifacts.thefocus.ai/a/Ab3xY9kQ" />',
    );
    expect(injected).toContain('<meta property="og:type" content="website" />');
    expect(injected).toContain(
      '<meta property="og:site_name" content="artifacts.thefocus.ai" />',
    );
    expect(injected).toContain(
      '<meta name="twitter:card" content="summary" />',
    );
    // No image: Publications can be served from any domain.
    expect(injected).not.toContain("og:image");
    expect(injected).not.toContain("twitter:image");
    expect(injected).toContain(
      '<meta name="twitter:title" content="Q2 Results" />',
    );
    // Tags sit inside <head>, after the author's own tags.
    expect(injected.indexOf('property="og:title"')).toBeGreaterThan(
      injected.indexOf("<title>"),
    );
    expect(injected.indexOf('property="og:title"')).toBeLessThan(
      injected.indexOf("</head>"),
    );
    expect(injected.endsWith("<h1>Q2</h1></body></html>")).toBe(true);
  });

  it("prefers the stored Publication title over the page title", () => {
    const injected = injectOpenGraphTags(
      "<html><head><title>Page title</title></head></html>",
      { title: "Explicit --title", ...card },
    );

    expect(injected).toContain(
      '<meta property="og:title" content="Explicit --title" />',
    );
    expect(injected).not.toContain('content="Page title"');
  });

  it("falls back to the host name and omits the description when the page has neither", () => {
    const injected = injectOpenGraphTags("<!doctype html><h1>Bare</h1>", {
      title: null,
      ...card,
    });

    expect(injected).toContain(
      '<meta property="og:title" content="artifacts.thefocus.ai" />',
    );
    expect(injected).not.toContain("og:description");
    expect(injected).not.toContain("twitter:description");
    // Without <head>, the card follows the doctype so browsers put it in <head>.
    expect(injected.startsWith("<!doctype html>\n<meta property=")).toBe(true);
    expect(injected.endsWith("<h1>Bare</h1>")).toBe(true);
  });

  it("inserts after an unclosed <head> and after <html> when there is no head", () => {
    const afterHead = injectOpenGraphTags(
      '<html><head lang="en"><title>T</title><body>x</body></html>',
      { title: null, ...card },
    );
    expect(
      afterHead.startsWith('<html><head lang="en">\n<meta property='),
    ).toBe(true);

    const afterHtml = injectOpenGraphTags("<html><body>x</body></html>", {
      title: null,
      ...card,
    });
    expect(afterHtml.startsWith("<html>\n<meta property=")).toBe(true);
  });

  it("leaves pages that already set og:title untouched", () => {
    const html =
      '<html><head><meta property="og:title" content="Mine"><meta property="og:description" content="Theirs"></head></html>';

    expect(injectOpenGraphTags(html, { title: "Stored", ...card })).toBe(html);
  });

  it("escapes attribute values", () => {
    const injected = injectOpenGraphTags(
      '<html><head><title>A &amp; B <"quoted"></title></head></html>',
      { title: null, ...card },
    );

    expect(injected).toContain(
      '<meta property="og:title" content="A &amp; B &lt;&quot;quoted&quot;&gt;" />',
    );
  });

  it("reads <meta name=description> in either attribute order", () => {
    expect(
      extractHtmlMetaDescription(
        '<meta content="First" name="description"><meta name="description" content="Second">',
      ),
    ).toBe("First");
    expect(
      extractHtmlMetaDescription("<meta name='description' content='Single'>"),
    ).toBe("Single");
    expect(
      extractHtmlMetaDescription("<meta name='keywords' content='x'>"),
    ).toBe(null);
  });
});

describe("Open Graph tags on served Publications", () => {
  it("serves the Entry Page with a card built from the stored title and the request origin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-og-"));
    const htmlPath = join(dir, "report.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><head><title>HTML title</title></head><body>ok</body></html>",
    );
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    await publishSingleFileArtifact({
      filePath: htmlPath,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "OgTitle1",
      manifestRef: "manifest-1",
      title: "Q2 Results",
    });

    const response = await servePublicationRequest({
      request: new Request("https://preview.vercel.app/a/OgTitle1/"),
      metadataStore,
      contentStore,
    });
    const html = await response.text();

    expect(html).toContain('<meta property="og:title" content="Q2 Results" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://preview.vercel.app/a/OgTitle1/" />',
    );
    expect(html).toContain(
      '<meta property="og:site_name" content="preview.vercel.app" />',
    );
    expect(html).toContain("<title>HTML title</title>");

    // og:url keeps the pasted form, minus an explicit index.html.
    const bare = await servePublicationRequest({
      request: new Request("https://artifacts.thefocus.ai/a/OgTitle1"),
      metadataStore,
      contentStore,
    });
    await expect(bare.text()).resolves.toContain(
      '<meta property="og:url" content="https://artifacts.thefocus.ai/a/OgTitle1" />',
    );
    const explicitIndex = await servePublicationRequest({
      request: new Request(
        "https://artifacts.thefocus.ai/a/OgTitle1/index.html",
      ),
      metadataStore,
      contentStore,
    });
    await expect(explicitIndex.text()).resolves.toContain(
      '<meta property="og:url" content="https://artifacts.thefocus.ai/a/OgTitle1/" />',
    );
  });

  it("leaves non-HTML assets and nested pages byte-exact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-og-dir-"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    await writeFile(join(dir, "data.json"), '{"title":"<title>x</title>"}');
    await writeFile(join(dir, "page.html"), "<h1>Page</h1>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    await publishDirectoryArtifact({
      directoryPath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "OgDir1",
      manifestRef: "manifest-dir",
    });

    async function serve(path: string) {
      const response = await servePublicationRequest({
        request: new Request(`https://artifacts.thefocus.ai/a/OgDir1${path}`),
        metadataStore,
        contentStore,
      });
      return response.text();
    }

    await expect(serve("")).resolves.toContain('property="og:title"');
    await expect(serve("/index.html")).resolves.toContain(
      'property="og:title"',
    );
    await expect(serve("/data.json")).resolves.toBe(
      '{"title":"<title>x</title>"}',
    );
    await expect(serve("/page.html")).resolves.toBe("<h1>Page</h1>");
  });

  it("uses the wildcard origin for PWA cards and the serving host as site name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-og-pwa-"));
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><head><title>Demo PWA</title><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>',
    );
    await writeFile(
      join(dir, "manifest.webmanifest"),
      JSON.stringify({ name: "Demo", icons: [{ src: "/icon.png" }] }),
    );
    await writeFile(join(dir, "sw.js"), "");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    await publishArtifact({
      sourcePath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      stateStore: new InMemoryPublicationStateStore(),
      pwa: true,
      opaqueIdFactory: () => "ogpwa1",
    });

    const response = await servePublicationRequest({
      request: new Request("https://ogpwa1.artifacts.thefocus.ai/"),
      metadataStore,
      contentStore,
    });
    const html = await response.text();

    expect(html).toContain('<meta property="og:title" content="Demo PWA" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://ogpwa1.artifacts.thefocus.ai/" />',
    );
    expect(html).toContain(
      '<meta property="og:site_name" content="ogpwa1.artifacts.thefocus.ai" />',
    );
    expect(html).not.toContain("og:image");
  });

  it("names the site after whatever domain served the Publication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-og-domain-"));
    const htmlPath = join(dir, "index.html");
    await writeFile(htmlPath, "<html><head><title>Deck</title></head></html>");
    const metadataStore = new InMemoryPublicationMetadataStore();
    const contentStore = new InMemoryArtifactContentStore();
    await publishSingleFileArtifact({
      filePath: htmlPath,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      metadataStore,
      contentStore,
      opaqueId: "OgDomain",
      manifestRef: "manifest-1",
    });

    const response = await servePublicationRequest({
      request: new Request("https://upperhandai.com/a/OgDomain"),
      metadataStore,
      contentStore,
    });
    const html = await response.text();

    expect(html).toContain(
      '<meta property="og:site_name" content="upperhandai.com" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://upperhandai.com/a/OgDomain" />',
    );
    expect(html).not.toContain("thefocus");
  });
});
