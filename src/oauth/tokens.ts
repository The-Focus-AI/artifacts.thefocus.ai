import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { OAuthStore, OAuthTokenKind, OAuthTokenRecord } from "./store.js";

export const accessTokenLifetimeMs = 60 * 60 * 1000;
export const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
export const authorizationCodeLifetimeMs = 60 * 1000;

const tokenPrefixes: Record<OAuthTokenKind, string> = {
  access: "tfai_at_",
  refresh: "tfai_rt_",
};

export function createOAuthToken(kind: OAuthTokenKind): string {
  return `${tokenPrefixes[kind]}${randomBytes(32).toString("base64url")}`;
}

export function createAuthorizationCode(): string {
  return `tfai_ac_${randomBytes(32).toString("base64url")}`;
}

export function hashOAuthSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** True when the string looks like a token this authorization server minted. */
export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(tokenPrefixes.access);
}

/**
 * RFC 7636 S256 verification. Constant-time so a mismatch does not leak how
 * much of the challenge matched.
 */
export function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const left = Buffer.from(computed);
  const right = Buffer.from(codeChallenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface IssueTokenPairInput {
  store: OAuthStore;
  clientId: string;
  publisherEmail: string;
  scope: string | null;
  resource: string | null;
  now?: () => Date;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export async function issueOAuthTokenPair(
  input: IssueTokenPairInput,
): Promise<IssuedTokenPair> {
  const now = input.now?.() ?? new Date();
  const accessToken = createOAuthToken("access");
  const refreshToken = createOAuthToken("refresh");

  for (const [token, kind, lifetime] of [
    [accessToken, "access", accessTokenLifetimeMs],
    [refreshToken, "refresh", refreshTokenLifetimeMs],
  ] as const) {
    await input.store.createToken({
      tokenHash: hashOAuthSecret(token),
      kind,
      clientId: input.clientId,
      publisherEmail: input.publisherEmail,
      scope: input.scope,
      resource: input.resource,
      expiresAt: new Date(now.getTime() + lifetime),
      createdAt: now,
    });
  }

  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(accessTokenLifetimeMs / 1000),
  };
}

export type OAuthTokenFailure =
  | "unknown"
  | "revoked"
  | "expired"
  | "wrong-kind"
  | "wrong-audience";

export type VerifyOAuthTokenResult =
  | { ok: true; record: OAuthTokenRecord }
  | { ok: false; reason: OAuthTokenFailure };

/**
 * Verify an access token, including its audience. A token issued for a
 * different resource must not be accepted here (RFC 8707): that is the whole
 * point of asking clients to send a `resource` parameter.
 */
export async function verifyOAuthAccessToken(input: {
  token: string;
  store: OAuthStore;
  resource: string;
  now?: () => Date;
}): Promise<VerifyOAuthTokenResult> {
  const record = await input.store.getToken(hashOAuthSecret(input.token));
  if (!record) return { ok: false, reason: "unknown" };
  if (record.kind !== "access") return { ok: false, reason: "wrong-kind" };
  if (record.revokedAt) return { ok: false, reason: "revoked" };
  const now = input.now?.() ?? new Date();
  if (record.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (record.resource && record.resource !== input.resource) {
    return { ok: false, reason: "wrong-audience" };
  }
  return { ok: true, record };
}
