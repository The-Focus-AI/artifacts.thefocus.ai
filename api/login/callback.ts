import type { IncomingMessage, ServerResponse } from "node:http";

import {
	issuePublisherToken,
	createNeonPublisherTokenStore,
	isTheFocusPublisherEmail,
	type PublisherTokenStore,
} from "../../src/auth.js";

import {
	createServerClerkVerifier,
	type ClerkVerifier,
	type ClerkVerification,
} from "../../src/auth-clerk.js";

export default async function handler(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const clerk = createServerClerkVerifier();
	await handleLoginCallback(request, response, {
		clerk,
		tokenStore: createNeonPublisherTokenStore(),
	});
}

export interface LoginCallbackDeps {
	clerk: ClerkVerifier;
	tokenStore: PublisherTokenStore;
	now?: () => Date;
	tokenFactory?: () => string;
}

export async function handleLoginCallback(
	nodeRequest: IncomingMessage,
	nodeResponse: ServerResponse,
	deps: LoginCallbackDeps,
): Promise<void> {
	const url = requestToUrl(nodeRequest);
	const portParam = url.searchParams.get("port");

	// Verify the Clerk session
	let verification: ClerkVerification | null;
	try {
		verification = await deps.clerk.verifyRequest(url.toString());
	} catch {
		showError(nodeResponse, "Authentication failed. Please try again.");
		return;
	}

	if (!verification?.email) {
		showError(
			nodeResponse,
			"Could not verify your email address. Please try again.",
		);
		return;
	}

	if (!isTheFocusPublisherEmail(verification.email)) {
		const port = parseInt(portParam ?? "0", 10);
		if (port > 0 && port < 65536) {
			redirect(
				nodeResponse,
				`http://localhost:${port}/callback?error=${encodeURIComponent(
					"Publishing is limited to verified email addresses ending exactly in @thefocus.ai.",
				)}`,
			);
			return;
		}
		showError(
			nodeResponse,
			`Publishing is limited to verified email addresses ending exactly in @thefocus.ai. Received: ${verification.email}`,
		);
		return;
	}

	// Issue the publisher token
	const result = await issuePublisherToken({
		email: verification.email,
		store: deps.tokenStore,
		now: deps.now,
		tokenFactory: deps.tokenFactory,
	});

	// Redirect to localhost callback with the token
	const port = parseInt(portParam ?? "0", 10);
	if (port > 0 && port < 65536) {
		redirect(
			nodeResponse,
			`http://localhost:${port}/callback?token=${encodeURIComponent(result.token)}`,
		);
		return;
	}

	// Fallback: display the token on a page
	showTokenDisplay(nodeResponse, result.token, verification.email);
}

function requestToUrl(request: IncomingMessage): URL {
	const host = request.headers.host ?? "localhost";
	const protocol = request.headers["x-forwarded-proto"] ?? "https";
	return new URL(request.url ?? "/", `${protocol}://${host}`);
}

function redirect(response: ServerResponse, location: string): void {
	response.writeHead(302, { Location: location });
	response.end();
}

function showError(response: ServerResponse, message: string): void {
	response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
	response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Login failed — Artifacts</title></head>
<body>
  <h1>Login failed</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Return to TheFocus.AI Artifacts</a></p>
</body>
</html>`);
}

function showTokenDisplay(
	response: ServerResponse,
	token: string,
	email: string,
): void {
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Publisher Token — Artifacts</title></head>
<body>
  <h1>Publisher Token for ${escapeHtml(email)}</h1>
  <p>Run the following command to store your Publisher Token:</p>
  <pre><code>artifacts login --token ${escapeHtml(token)}</code></pre>
  <p>This token is your local credential for publishing. Store it in a safe place.</p>
  <p><a href="/">Return to TheFocus.AI Artifacts</a></p>
</body>
</html>`);
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
