import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  InMemoryPublisherTokenStore,
  hashPublisherToken,
} from "../src/auth.js";
import { handleLoginCallback } from "../api/login/callback.js";

class FakeClerkVerifier {
  private email: string;

  constructor(email: string) {
    this.email = email;
  }

  async authenticateRequest(_request: IncomingMessage) {
    return {
      kind: "authenticated" as const,
      verification: { email: this.email, userId: "test_user_id" },
    };
  }
}

function createTestRequest(
  path: string,
  host = "artifacts.thefocus.ai",
): IncomingMessage {
  return {
    url: path,
    headers: { host },
  } as IncomingMessage;
}

function createTestResponse(): ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          this.headers[name] = value;
        }
      }
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
  } as ServerResponse & {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  };
  return res;
}

describe("/login/callback route", () => {
  const now = new Date("2026-05-21T12:00:00.000Z");

  it("issues a token and redirects to localhost callback for valid @thefocus.ai email", async () => {
    const req = createTestRequest("/login/callback?port=12345");
    const res = createTestResponse();
    const clerk = new FakeClerkVerifier("publisher@thefocus.ai");
    const tokenStore = new InMemoryPublisherTokenStore();

    await handleLoginCallback(req, res, {
      clerk,
      tokenStore,
      now: () => now,
      tokenFactory: () => "tfai_pub_test_browser",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toContain(
      "http://localhost:12345/callback",
    );
    expect(res.headers["Location"]).toContain("token=tfai_pub_test_browser");

    const record = await tokenStore.getByTokenHash(
      hashPublisherToken("tfai_pub_test_browser"),
    );
    expect(record).toMatchObject({
      publisherEmail: "publisher@thefocus.ai",
    });
  });

  it("forwards Clerk handshake redirects during development auth sync", async () => {
    const req = createTestRequest("/login/callback?__clerk_db_jwt=dvb_test");
    const res = createTestResponse();
    const tokenStore = new InMemoryPublisherTokenStore();
    const headers = new Headers({
      Location: "https://clerk.example.com/v1/client/handshake",
    });

    const clerk = {
      authenticateRequest: async (_request: IncomingMessage) => ({
        kind: "redirect" as const,
        headers,
      }),
    };

    await handleLoginCallback(req, res, { clerk, tokenStore });

    expect(res.statusCode).toBe(307);
    expect(res.headers["Location"]).toBe(
      "https://clerk.example.com/v1/client/handshake",
    );
  });

  it("redirects to localhost with error for non-@thefocus.ai email", async () => {
    const req = createTestRequest("/login/callback?port=12345");
    const res = createTestResponse();
    const clerk = new FakeClerkVerifier("outsider@gmail.com");
    const tokenStore = new InMemoryPublisherTokenStore();

    await handleLoginCallback(req, res, { clerk, tokenStore });

    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toContain(
      "http://localhost:12345/callback",
    );
    expect(res.headers["Location"]).toContain("error=");
    expect(res.headers["Location"]).not.toContain("token=");
  });

  it("shows an authorization error page when non-@thefocus.ai and no localhost port", async () => {
    const req = createTestRequest("/login/callback");
    const res = createTestResponse();
    const clerk = new FakeClerkVerifier("outsider@gmail.com");
    const tokenStore = new InMemoryPublisherTokenStore();

    await handleLoginCallback(req, res, { clerk, tokenStore });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("@thefocus.ai");
    expect(res.body).toContain("Login not allowed");
  });

  it("shows a token display page when no localhost callback port", async () => {
    const req = createTestRequest("/login/callback");
    const res = createTestResponse();
    const clerk = new FakeClerkVerifier("publisher@thefocus.ai");
    const tokenStore = new InMemoryPublisherTokenStore();

    await handleLoginCallback(req, res, {
      clerk,
      tokenStore,
      tokenFactory: () => "tfai_pub_display",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("npx @the-focus-ai/artifacts login --token");
    expect(res.body).toContain("tfai_pub_display");
  });

  it("shows an error page when Clerk verification throws", async () => {
    const req = createTestRequest("/login/callback?port=12345");
    const res = createTestResponse();

    class ThrowingClerkVerifier {
      async authenticateRequest(_request: IncomingMessage): Promise<never> {
        throw new Error("Clerk verification failed");
      }
    }

    const clerk = new ThrowingClerkVerifier();
    const tokenStore = new InMemoryPublisherTokenStore();

    await handleLoginCallback(req, res, { clerk, tokenStore });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Authentication failed");
  });
});
