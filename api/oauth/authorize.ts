import type { IncomingMessage, ServerResponse } from "node:http";

import {
  buildClerkSignInUrl,
  createServerClerkVerifier,
  type ClerkVerifier,
} from "../../src/auth-clerk.js";
import { nodeRequestToWebRequest, nodeRequestUrl } from "../../src/http.js";
import {
  consentPageHtml,
  oauthErrorPageHtml,
} from "../../src/oauth/consent-page.js";
import {
  handleAuthorize,
  readAuthorizeParams,
} from "../../src/oauth/endpoints.js";
import { createNeonOAuthStore } from "../../src/oauth/store.js";
import type { OAuthStore } from "../../src/oauth/store.js";
import { defaultPublicBaseUrl } from "../../src/publication.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await handleAuthorizeRequest(request, response, {
    clerk: createServerClerkVerifier(),
    store: createNeonOAuthStore(),
    publicBaseUrl:
      process.env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
  });
}

export interface AuthorizeRouteDeps {
  clerk: ClerkVerifier;
  store: OAuthStore;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export async function handleAuthorizeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AuthorizeRouteDeps,
): Promise<void> {
  const requestUrl = nodeRequestUrl(request);
  const url = new URL(requestUrl);

  // On approval the browser POSTs the same parameters back as form fields, so
  // the decision travels with the request that acts on it.
  let params = url.searchParams;
  let approved = false;
  if (request.method === "POST") {
    // The consent POST acts on the browser's Clerk session, so a cross-site
    // form could otherwise approve a client the Publisher never saw.
    if (!isSameOriginSubmission(request)) {
      sendHtml(
        response,
        403,
        oauthErrorPageHtml(
          "This approval did not come from the Artifacts consent page. Start the login again from your client.",
        ),
      );
      return;
    }
    const form = new URLSearchParams(
      await (await nodeRequestToWebRequest(request)).text(),
    );
    if (form.get("approve") !== "yes") {
      sendHtml(response, 200, oauthErrorPageHtml("Authorization cancelled."));
      return;
    }
    params = form;
    approved = true;
  }

  const publisherEmail = await signedInPublisher(request, response, deps.clerk);
  if (publisherEmail === "response-sent") return;

  const outcome = await handleAuthorize({
    params: readAuthorizeParams(params),
    store: deps.store,
    publicBaseUrl: deps.publicBaseUrl,
    publisherEmail,
    requestUrl,
    approved,
    fetchImpl: deps.fetchImpl,
  });

  switch (outcome.kind) {
    case "error-page":
      sendHtml(response, outcome.status, oauthErrorPageHtml(outcome.message));
      return;
    case "error-redirect":
    case "code-issued":
      response.writeHead(302, { Location: outcome.location });
      response.end();
      return;
    case "sign-in-required":
      response.writeHead(302, {
        Location: buildClerkSignInUrl(outcome.returnUrl),
      });
      response.end();
      return;
    case "consent":
      sendHtml(
        response,
        200,
        consentPageHtml({
          clientId: outcome.client.clientId,
          clientName: outcome.client.clientName,
          publisherEmail: publisherEmail ?? "",
          hiddenFields: [...params.entries()].filter(
            ([key]) => key !== "approve",
          ),
        }),
      );
      return;
  }
}

/**
 * Resolve the browser's Clerk session. Returns null when nobody is signed in,
 * so the caller can send them through sign-in and come back.
 */
async function signedInPublisher(
  request: IncomingMessage,
  response: ServerResponse,
  clerk: ClerkVerifier,
): Promise<string | null | "response-sent"> {
  const result = await clerk.authenticateRequest(request);
  if (result.kind === "redirect") {
    const location = result.headers.get("location");
    if (!location) return null;
    for (const [name, value] of result.headers.entries()) {
      if (name.toLowerCase() === "location") continue;
      response.setHeader(name, value);
    }
    response.writeHead(307, { Location: location });
    response.end();
    return "response-sent";
  }
  if (result.kind === "unauthenticated") return null;
  return result.verification.email;
}

/**
 * Accept a form POST only when the browser says it came from this site.
 *
 * Compares hosts rather than full origins: behind a TLS-terminating proxy the
 * request's own scheme is reconstructed from `x-forwarded-proto`, so a scheme
 * comparison would reject legitimate submissions. The host is what the browser
 * actually used, and an attacker's page has a different one.
 */
function isSameOriginSubmission(request: IncomingMessage): boolean {
  const origin = firstHeader(request.headers.origin);
  const host = firstHeader(request.headers.host);
  if (origin && host) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  // Origin is omitted by a few older browsers on same-origin form posts.
  return firstHeader(request.headers["sec-fetch-site"]) === "same-origin";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}
