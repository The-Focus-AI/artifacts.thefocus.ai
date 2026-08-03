import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { livingDocViewRequestUrl, publicationRequestUrl } from "../src/http.js";

describe("Vercel Publication routing", () => {
  it("maps rewritten /api/a/{opaque} function requests back to canonical /a/{opaque} Publication URLs", () => {
    const request = {
      url: "/api/a/Ab3xY9kQ/assets/app.js",
      headers: {
        host: "artifacts.thefocus.ai",
        "x-forwarded-proto": "https",
      },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://artifacts.thefocus.ai/a/Ab3xY9kQ/assets/app.js",
    );
  });

  it("uses Vercel dynamic route query params when available", () => {
    const request = {
      url: "/api/a/ignored",
      headers: { host: "preview.vercel.app" },
      query: { opaque: "QueryOpaque" },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://preview.vercel.app/a/QueryOpaque",
    );
  });

  it("keeps the trailing slash that the rewrite tags with trailingSlash=1", () => {
    const request = {
      url: "/api/a/QueryOpaque?trailingSlash=1",
      headers: { host: "artifacts.thefocus.ai" },
      query: { opaque: "QueryOpaque", trailingSlash: "1" },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://artifacts.thefocus.ai/a/QueryOpaque/",
    );
  });

  it("keeps the trailing slash on a plain Node request", () => {
    const request = {
      url: "/a/Ab3xY9kQ/",
      headers: { host: "localhost:3000", "x-forwarded-proto": "http" },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "http://localhost:3000/a/Ab3xY9kQ/",
    );
  });
});

describe("Vercel Living Doc View routing", () => {
  it("keeps the tagged trailing slash and drops the internal marker", () => {
    const request = {
      url: "/api/d/DocOpaque?trailingSlash=1&format=json",
      headers: { host: "artifacts.thefocus.ai" },
      query: { opaque: "DocOpaque", trailingSlash: "1" },
    };

    expect(livingDocViewRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://artifacts.thefocus.ai/d/DocOpaque/?format=json",
    );
  });

  it("leaves nested Doc Asset paths alone", () => {
    const request = {
      url: "/api/d/DocOpaque?path=assets/dot.png",
      headers: { host: "artifacts.thefocus.ai" },
      query: { opaque: "DocOpaque", path: "assets/dot.png" },
    };

    expect(livingDocViewRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://artifacts.thefocus.ai/d/DocOpaque/assets/dot.png?path=assets%2Fdot.png",
    );
  });
});
