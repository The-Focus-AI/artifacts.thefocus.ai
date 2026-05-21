import { describe, expect, it } from "vitest";

import {
	InMemoryPublisherTokenStore,
	hashPublisherToken,
} from "../src/auth.js";
import { handleLoginRequest, type LoginDependencies } from "../api/login.js";
import type { IncomingMessage, ServerResponse } from "node:http";

class FakeClerkVerifier {
	private email: string;

	constructor(email: string) {
		this.email = email;
	}

	buildSignInUrl(currentUrl: string): string {
		const url = new URL(currentUrl);
		return `https://clerk.artifacts.thefocus.ai/sign-in?redirect_url=${encodeURIComponent(currentUrl)}`;
	}

	async verifyRequest(_url: string) {
		return { email: this.email, userId: "test_user_id" };
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
		writeHead(statusCode: number, headers?: Record<string, string>) {
			this.statusCode = statusCode;
			if (headers) {
				if ("Location" in headers && typeof headers.Location === "string") {
					this.headers["Location"] = headers.Location;
				}
				if (
					"Content-Type" in headers &&
					typeof headers["Content-Type"] === "string"
				) {
					this.headers["Content-Type"] = headers["Content-Type"];
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

describe("Login API route", () => {
	const now = new Date("2026-05-21T12:00:00.000Z");

	it("redirects to Clerk sign-in when no session token is present", async () => {
		const req = createTestRequest("/login?port=12345");
		const res = createTestResponse();
		const clerk = new FakeClerkVerifier("publisher@thefocus.ai");
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, { clerk, tokenStore });

		expect(res.statusCode).toBe(302);
		expect(res.headers["Location"]).toContain("clerk");
	});

	it("issues a token and redirects to localhost callback for valid @thefocus.ai email", async () => {
		const req = createTestRequest("/login?port=12345&__clerk_db_jwt=fake-jwt");
		const res = createTestResponse();
		const clerk = new FakeClerkVerifier("publisher@thefocus.ai");
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, {
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

		// Verify the token was stored with a hash
		const record = await tokenStore.getByTokenHash(
			hashPublisherToken("tfai_pub_test_browser"),
		);
		expect(record).toMatchObject({
			publisherEmail: "publisher@thefocus.ai",
		});
	});

	it("redirects to localhost with error for non-@thefocus.ai email", async () => {
		const req = createTestRequest("/login?port=12345&__clerk_db_jwt=fake-jwt");
		const res = createTestResponse();
		const clerk = new FakeClerkVerifier("outsider@gmail.com");
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, { clerk, tokenStore });

		expect(res.statusCode).toBe(302);
		expect(res.headers["Location"]).toContain(
			"http://localhost:12345/callback",
		);
		expect(res.headers["Location"]).toContain("error=");
		expect(res.headers["Location"]).not.toContain("token=");
	});

	it("shows an error page when non-@thefocus.ai email and no localhost callback port", async () => {
		const req = createTestRequest("/login?__clerk_db_jwt=fake-jwt");
		const res = createTestResponse();
		const clerk = new FakeClerkVerifier("outsider@gmail.com");
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, { clerk, tokenStore });

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("@thefocus.ai");
		expect(res.body).toContain("Login failed");
	});

	it("shows a token display page when no localhost callback port is provided", async () => {
		const req = createTestRequest("/login?__clerk_db_jwt=fake-jwt");
		const res = createTestResponse();
		const clerk = new FakeClerkVerifier("publisher@thefocus.ai");
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, {
			clerk,
			tokenStore,
			tokenFactory: () => "tfai_pub_display",
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("artifacts login --token");
		expect(res.body).toContain("tfai_pub_display");
	});

	it("shows an error page when Clerk verification throws", async () => {
		const req = createTestRequest("/login?port=12345&__clerk_db_jwt=fake-jwt");
		const res = createTestResponse();

		class ThrowingClerkVerifier {
			buildSignInUrl(url: string): string {
				return `https://clerk.example.com/sign-in?redirect_url=${url}`;
			}
			async verifyRequest(
				_url: string,
			): Promise<{ email: string; userId: string } | null> {
				throw new Error("Clerk verification failed");
			}
		}

		const clerk = new ThrowingClerkVerifier();
		const tokenStore = new InMemoryPublisherTokenStore();

		await handleLoginRequest(req, res, { clerk, tokenStore });

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("Authentication failed");
	});
});
