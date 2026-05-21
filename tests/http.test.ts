import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { publicationRequestUrl } from "../src/http.js";

describe("Vercel Publication routing", () => {
  it("maps rewritten /api/a/{opaque} function requests back to canonical /a/{opaque} Publication URLs", () => {
    const request = {
      url: "/api/a/Ab3xY9kQ",
      headers: {
        host: "artifacts.thefocus.ai",
        "x-forwarded-proto": "https",
      },
    };

    expect(publicationRequestUrl(request as unknown as IncomingMessage)).toBe(
      "https://artifacts.thefocus.ai/a/Ab3xY9kQ",
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
});
