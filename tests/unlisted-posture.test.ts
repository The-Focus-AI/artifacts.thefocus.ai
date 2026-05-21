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
		const html = await readProjectFile("public/index.html");

		expect(html).toContain("TheFocus.AI");
		expect(html).toContain("Artifacts");
		expect(html).toContain('href="https://thefocus.ai/"');
	});

	it("does not expose a public Publication listing", async () => {
		const html = await readProjectFile("public/index.html");
		const vercelConfig = JSON.parse(await readProjectFile("vercel.json")) as {
			rewrites?: Array<{ source: string; destination: string }>;
		};

		expect(html).not.toMatch(
			/Publication listing|Recent Publications|<ul[^>]*id="?publications/i,
		);
		expect(vercelConfig.rewrites).toEqual([
			{ source: "/login", destination: "/api/login" },
			{ source: "/a/:opaque", destination: "/api/a/:opaque" },
			{ source: "/a/:opaque/:path*", destination: "/api/a/:opaque/:path*" },
		]);
	});
});

describe("robots and Publication indexing posture", () => {
	it("disallows crawling Publication URLs", async () => {
		await expect(readProjectFile("public/robots.txt")).resolves.toBe(
			"User-agent: *\nDisallow: /a/\n",
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
