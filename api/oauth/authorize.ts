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

  const session = await signedInPublisher(request, response, deps.clerk);
  if (session.kind === "response-sent") return;
  // Clerk may hand back a Set-Cookie that persists the session on this domain
  // after a handshake. Without it the consent POST looks signed out.
  applyClerkHeaders(response, session.headers);

  // Where to resume after sign-in. Rebuilt from the parameters rather than
  // reusing the request URL, so an unauthenticated consent POST still comes
  // back with its OAuth parameters intact.
  const resumeUrl = new URL(`${url.origin}${url.pathname}`);
  for (const [key, value] of params.entries()) {
    if (key === "approve" || key === signInAttemptedParam) continue;
    resumeUrl.searchParams.set(key, value);
  }

  const outcome = await handleAuthorize({
    params: readAuthorizeParams(params),
    store: deps.store,
    publicBaseUrl: deps.publicBaseUrl,
    publisherEmail: session.email,
    requestUrl: resumeUrl.toString(),
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
    case "sign-in-required": {
      // Loop breaker. Sign-in bounces the browser back here; if it returns
      // still unauthenticated we must not send it round again, or the two
      // sides ping-pong forever. Once is a redirect, twice is an explanation.
      if (url.searchParams.has(signInAttemptedParam)) {
        sendHtml(
          response,
          401,
          oauthErrorPageHtml(
            `Signed in with Clerk, but this site did not receive a session${
              session.message ? ` (${session.message})` : ""
            }. Check that third-party cookies are allowed for artifacts.thefocus.ai, then start the login again from your client.`,
          ),
        );
        return;
      }
      const returnUrl = new URL(outcome.returnUrl);
      returnUrl.searchParams.set(signInAttemptedParam, "1");
      response.writeHead(302, {
        Location: buildClerkSignInUrl(returnUrl.toString()),
      });
      response.end();
      return;
    }
    case "consent":
      sendHtml(
        response,
        200,
        consentPageHtml({
          clientId: outcome.client.clientId,
          clientName: outcome.client.clientName,
          publisherEmail: session.email ?? "",
          hiddenFields: [...params.entries()].filter(
            ([key]) => key !== "approve" && key !== signInAttemptedParam,
          ),
        }),
      );
      return;
  }
}

/** Marks that we already sent this browser through Clerk sign-in once. */
const signInAttemptedParam = "__artifacts_signin";

type ClerkSession =
  | {
      kind: "resolved";
      email: string | null;
      message?: string;
      headers?: Headers;
    }
  | { kind: "response-sent" };

/**
 * Resolve the browser's Clerk session. `email: null` means nobody is signed in
 * yet, so the caller can send them through sign-in — once.
 */
async function signedInPublisher(
  request: IncomingMessage,
  response: ServerResponse,
  clerk: ClerkVerifier,
): Promise<ClerkSession> {
  const result = await clerk.authenticateRequest(request);

  if (result.kind === "redirect") {
    const location = result.headers.get("location");
    if (!location) {
      // A handshake with nowhere to go cannot be completed by redirecting;
      // treat it as "not signed in" and let the loop breaker handle it.
      return {
        kind: "resolved",
        email: null,
        message: "Clerk requested a handshake without a redirect location",
        headers: result.headers,
      };
    }
    applyClerkHeaders(response, result.headers, { skipLocation: true });
    response.writeHead(307, { Location: location });
    response.end();
    return { kind: "response-sent" };
  }

  if (result.kind === "unauthenticated") {
    return {
      kind: "resolved",
      email: null,
      message: result.message,
      headers: result.headers,
    };
  }

  return {
    kind: "resolved",
    email: result.verification.email,
    headers: result.headers,
  };
}

/**
 * Copy Clerk's headers onto our response. `Set-Cookie` is handled separately
 * because iterating `Headers` folds repeated cookies into one comma-joined
 * value, which browsers reject.
 */
function applyClerkHeaders(
  response: ServerResponse,
  headers: Headers | undefined,
  options: { skipLocation?: boolean } = {},
): void {
  if (!headers) return;
  const setCookie = headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie") continue;
    if (options.skipLocation && lower === "location") continue;
    response.setHeader(name, value);
  }
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
