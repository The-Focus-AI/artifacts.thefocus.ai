import { randomBytes } from "node:crypto";

import { isTheFocusPublisherEmail } from "../auth.js";
import {
  OAuthClientError,
  redirectUriIsRegistered,
  registerOAuthClient,
  resolveOAuthClient,
} from "./clients.js";
import { artifactsOAuthScope, mcpResourceIdentifier } from "./metadata.js";
import type { OAuthStore } from "./store.js";
import {
  authorizationCodeLifetimeMs,
  createAuthorizationCode,
  hashOAuthSecret,
  issueOAuthTokenPair,
  verifyPkceS256,
} from "./tokens.js";

export interface AuthorizeRequestParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

export function readAuthorizeParams(
  params: URLSearchParams,
): AuthorizeRequestParams {
  return {
    responseType: params.get("response_type"),
    clientId: params.get("client_id"),
    redirectUri: params.get("redirect_uri"),
    codeChallenge: params.get("code_challenge"),
    codeChallengeMethod: params.get("code_challenge_method"),
    state: params.get("state"),
    scope: params.get("scope"),
    resource: params.get("resource"),
  };
}

export type AuthorizeOutcome =
  /** Show the user an error. Never redirect: the redirect target is untrusted. */
  | { kind: "error-page"; status: number; message: string }
  /** Bounce the browser back to the client with an OAuth error. */
  | { kind: "error-redirect"; location: string }
  /** The user must sign in first; resume at `returnUrl` afterwards. */
  | { kind: "sign-in-required"; returnUrl: string }
  /** Ask the signed-in Publisher to approve this client. */
  | { kind: "consent"; client: { clientId: string; clientName: string | null } }
  /** Approved: send the browser back to the client with a code. */
  | { kind: "code-issued"; location: string };

export interface AuthorizeInput {
  params: AuthorizeRequestParams;
  store: OAuthStore;
  publicBaseUrl: string;
  /** The signed-in Publisher, or null when the browser has no session yet. */
  publisherEmail: string | null;
  /** This request's own URL, used to resume after sign-in. */
  requestUrl: string;
  approved: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  codeFactory?: () => string;
}

/**
 * The authorization endpoint. Validates the client before anything else,
 * because until `client_id` and `redirect_uri` are known good there is nowhere
 * safe to send an error.
 */
export async function handleAuthorize(
  input: AuthorizeInput,
): Promise<AuthorizeOutcome> {
  const { params } = input;

  if (!params.clientId) {
    return errorPage(400, "client_id is required.");
  }
  if (!params.redirectUri) {
    return errorPage(400, "redirect_uri is required.");
  }

  let client;
  try {
    client = await resolveOAuthClient({
      clientId: params.clientId,
      store: input.store,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof OAuthClientError) {
      return errorPage(400, error.message);
    }
    throw error;
  }

  if (!redirectUriIsRegistered(client, params.redirectUri)) {
    return errorPage(
      400,
      "redirect_uri does not exactly match one registered by this client.",
    );
  }

  // From here the redirect target is trusted, so OAuth errors go back to it.
  const fail = (code: string, description: string): AuthorizeOutcome =>
    errorRedirect(params.redirectUri!, code, description, params.state);

  if (params.responseType !== "code") {
    return fail("unsupported_response_type", "response_type must be 'code'.");
  }
  if (!params.codeChallenge) {
    return fail("invalid_request", "code_challenge is required (PKCE).");
  }
  if (params.codeChallengeMethod !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  if (params.scope && !scopeIsAllowed(params.scope)) {
    return fail("invalid_scope", `Supported scope: ${artifactsOAuthScope}.`);
  }

  const expectedResource = mcpResourceIdentifier(input.publicBaseUrl);
  if (params.resource && !resourceMatches(params.resource, expectedResource)) {
    return fail(
      "invalid_target",
      `This authorization server issues tokens for ${expectedResource}.`,
    );
  }

  if (!input.publisherEmail) {
    return { kind: "sign-in-required", returnUrl: input.requestUrl };
  }
  if (!isTheFocusPublisherEmail(input.publisherEmail)) {
    return errorPage(
      403,
      "Publishing is limited to verified email addresses ending exactly in @thefocus.ai.",
    );
  }

  if (!input.approved) {
    return {
      kind: "consent",
      client: { clientId: client.clientId, clientName: client.clientName },
    };
  }

  const now = input.now?.() ?? new Date();
  const code = input.codeFactory?.() ?? createAuthorizationCode();
  await input.store.createAuthorizationCode({
    codeHash: hashOAuthSecret(code),
    clientId: client.clientId,
    publisherEmail: input.publisherEmail,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope ?? artifactsOAuthScope,
    resource: params.resource ?? expectedResource,
    expiresAt: new Date(now.getTime() + authorizationCodeLifetimeMs),
  });

  const location = new URL(params.redirectUri);
  location.searchParams.set("code", code);
  if (params.state) location.searchParams.set("state", params.state);
  return { kind: "code-issued", location: location.toString() };
}

export interface TokenInput {
  form: URLSearchParams;
  store: OAuthStore;
  publicBaseUrl: string;
  now?: () => Date;
}

export interface TokenOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The token endpoint. Public clients only — there is no client secret to
 * present, so PKCE is what binds a code to the client that requested it.
 */
export async function handleToken(input: TokenInput): Promise<TokenOutcome> {
  const grantType = input.form.get("grant_type");
  if (grantType === "authorization_code") {
    return exchangeAuthorizationCode(input);
  }
  if (grantType === "refresh_token") {
    return exchangeRefreshToken(input);
  }
  return tokenError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token.",
  );
}

async function exchangeAuthorizationCode(
  input: TokenInput,
): Promise<TokenOutcome> {
  const code = input.form.get("code");
  const clientId = input.form.get("client_id");
  const redirectUri = input.form.get("redirect_uri");
  const codeVerifier = input.form.get("code_verifier");

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return tokenError(
      "invalid_request",
      "code, client_id, redirect_uri, and code_verifier are all required.",
    );
  }

  const now = input.now?.() ?? new Date();
  const record = await input.store.consumeAuthorizationCode(
    hashOAuthSecret(code),
    now,
  );
  if (!record) {
    return tokenError(
      "invalid_grant",
      "This authorization code is unknown or has already been used.",
    );
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return tokenError("invalid_grant", "This authorization code has expired.");
  }
  if (record.clientId !== clientId) {
    return tokenError(
      "invalid_grant",
      "This authorization code was issued to a different client.",
    );
  }
  if (record.redirectUri !== redirectUri) {
    return tokenError(
      "invalid_grant",
      "redirect_uri does not match the one the code was issued for.",
    );
  }
  if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
    return tokenError("invalid_grant", "PKCE verification failed.");
  }

  const issued = await issueOAuthTokenPair({
    store: input.store,
    clientId: record.clientId,
    publisherEmail: record.publisherEmail,
    scope: record.scope,
    resource: record.resource,
    now: () => now,
  });
  return {
    status: 200,
    body: {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresInSeconds,
      refresh_token: issued.refreshToken,
      scope: record.scope ?? artifactsOAuthScope,
    },
  };
}

async function exchangeRefreshToken(input: TokenInput): Promise<TokenOutcome> {
  const refreshToken = input.form.get("refresh_token");
  const clientId = input.form.get("client_id");
  if (!refreshToken || !clientId) {
    return tokenError(
      "invalid_request",
      "refresh_token and client_id are required.",
    );
  }

  const now = input.now?.() ?? new Date();
  const record = await input.store.getToken(hashOAuthSecret(refreshToken));
  if (!record || record.kind !== "refresh") {
    return tokenError("invalid_grant", "Unknown refresh token.");
  }
  if (record.revokedAt) {
    return tokenError("invalid_grant", "This refresh token was revoked.");
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return tokenError("invalid_grant", "This refresh token has expired.");
  }
  if (record.clientId !== clientId) {
    return tokenError(
      "invalid_grant",
      "This refresh token was issued to a different client.",
    );
  }

  // Rotate: a refresh token is single-use, so a stolen one is detectable by
  // the legitimate client's next refresh failing.
  await input.store.revokeToken(record.tokenHash, now);
  const issued = await issueOAuthTokenPair({
    store: input.store,
    clientId: record.clientId,
    publisherEmail: record.publisherEmail,
    scope: record.scope,
    resource: record.resource,
    now: () => now,
  });
  return {
    status: 200,
    body: {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresInSeconds,
      refresh_token: issued.refreshToken,
      scope: record.scope ?? artifactsOAuthScope,
    },
  };
}

export interface RegisterInput {
  metadata: { client_name?: unknown; redirect_uris?: unknown };
  store: OAuthStore;
  now?: () => Date;
  clientIdFactory?: () => string;
}

export async function handleRegister(
  input: RegisterInput,
): Promise<TokenOutcome> {
  try {
    const client = await registerOAuthClient({
      metadata: input.metadata,
      store: input.store,
      now: input.now,
      clientIdFactory:
        input.clientIdFactory ??
        (() => `tfai_client_${randomBytes(16).toString("base64url")}`),
    });
    return {
      status: 201,
      body: {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      },
    };
  } catch (error) {
    if (error instanceof OAuthClientError) {
      return {
        status: 400,
        body: { error: error.code, error_description: error.message },
      };
    }
    throw error;
  }
}

function scopeIsAllowed(scope: string): boolean {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .every((entry) => entry === artifactsOAuthScope);
}

/**
 * Resource identifiers compare as URLs, so a trailing slash difference is not
 * a mismatch worth failing a login over.
 */
function resourceMatches(requested: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  return normalize(requested) === normalize(expected);
}

function errorPage(status: number, message: string): AuthorizeOutcome {
  return { kind: "error-page", status, message };
}

function errorRedirect(
  redirectUri: string,
  code: string,
  description: string,
  state: string | null,
): AuthorizeOutcome {
  const location = new URL(redirectUri);
  location.searchParams.set("error", code);
  location.searchParams.set("error_description", description);
  if (state) location.searchParams.set("state", state);
  return { kind: "error-redirect", location: location.toString() };
}

function tokenError(error: string, description: string): TokenOutcome {
  return { status: 400, body: { error, error_description: description } };
}
