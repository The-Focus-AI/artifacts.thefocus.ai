import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  artifactsOAuthScope,
  authorizationServerMetadata,
  handleArtifactsMcpRequest,
  handleAuthorize,
  handleRegister,
  handleToken,
  InMemoryArtifactContentStore,
  InMemoryDocAssetContentStore,
  InMemoryLivingDocMetadataStore,
  InMemoryOAuthStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  InMemoryPublisherTokenStore,
  mcpResourceIdentifier,
  protectedResourceMetadata,
  readAuthorizeParams,
  resolveOAuthClient,
} from "../src/index.js";

const publicBaseUrl = "https://artifacts.thefocus.ai";
const resource = mcpResourceIdentifier(publicBaseUrl);
const redirectUri = "http://localhost:47821/callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function registeredClient(store: InMemoryOAuthStore) {
  const outcome = await handleRegister({
    metadata: { client_name: "Test Client", redirect_uris: [redirectUri] },
    store,
  });
  expect(outcome.status).toBe(201);
  return (outcome.body as { client_id: string }).client_id;
}

function authorizeParams(
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
) {
  return readAuthorizeParams(
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque-state",
      scope: artifactsOAuthScope,
      resource,
      ...overrides,
    }),
  );
}

/** Run the browser half of the flow and return the issued authorization code. */
async function authorizeToCode(
  store: InMemoryOAuthStore,
  clientId: string,
  challenge: string,
): Promise<string> {
  const outcome = await handleAuthorize({
    params: authorizeParams(clientId, challenge),
    store,
    publicBaseUrl,
    publisherEmail: "publisher@thefocus.ai",
    requestUrl: `${publicBaseUrl}/oauth/authorize`,
    approved: true,
  });
  if (outcome.kind !== "code-issued") {
    throw new Error(`expected a code, got ${outcome.kind}`);
  }
  const code = new URL(outcome.location).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

describe("discovery documents", () => {
  it("points a client from the resource to its authorization server", () => {
    const prm = protectedResourceMetadata(publicBaseUrl);
    expect(prm.resource).toBe("https://artifacts.thefocus.ai/mcp");
    expect(prm.authorization_servers).toEqual([
      "https://artifacts.thefocus.ai",
    ]);
  });

  it("advertises CIMD support alongside the deprecated DCR endpoint", () => {
    const metadata = authorizationServerMetadata(publicBaseUrl);
    // STD-009 R2 3.12: our own clients are told to prefer CIMD.
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBe(
      "https://artifacts.thefocus.ai/oauth/register",
    );
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.grant_types_supported).toContain("refresh_token");
  });
});

describe("authorization endpoint", () => {
  it("sends an unauthenticated browser to sign in and resume", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge),
      store,
      publicBaseUrl,
      publisherEmail: null,
      requestUrl: `${publicBaseUrl}/oauth/authorize?x=1`,
      approved: false,
    });

    expect(outcome).toEqual({
      kind: "sign-in-required",
      returnUrl: `${publicBaseUrl}/oauth/authorize?x=1`,
    });
  });

  it("asks a signed-in Publisher for consent before issuing a code", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge),
      store,
      publicBaseUrl,
      publisherEmail: "publisher@thefocus.ai",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: false,
    });

    expect(outcome.kind).toBe("consent");
  });

  it("refuses a non-thefocus.ai signed-in user", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge),
      store,
      publicBaseUrl,
      publisherEmail: "someone@example.com",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: true,
    });

    expect(outcome).toMatchObject({ kind: "error-page", status: 403 });
  });

  it("shows an error page rather than redirecting when the client is unknown", async () => {
    const store = new InMemoryOAuthStore();
    const outcome = await handleAuthorize({
      params: authorizeParams("nope", pkce().challenge),
      store,
      publicBaseUrl,
      publisherEmail: "publisher@thefocus.ai",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: true,
    });

    expect(outcome).toMatchObject({ kind: "error-page" });
  });

  it("shows an error page when redirect_uri is not an exact registered match", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge, {
        redirect_uri: "http://localhost:47821/callback/evil",
      }),
      store,
      publicBaseUrl,
      publisherEmail: "publisher@thefocus.ai",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: true,
    });

    expect(outcome).toMatchObject({ kind: "error-page" });
  });

  it("redirects protocol errors back to a validated redirect_uri", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge, {
        code_challenge_method: "plain",
      }),
      store,
      publicBaseUrl,
      publisherEmail: "publisher@thefocus.ai",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: true,
    });

    expect(outcome.kind).toBe("error-redirect");
    const location = new URL((outcome as { location: string }).location);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("opaque-state");
  });

  it("refuses a token request for someone else's resource", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const outcome = await handleAuthorize({
      params: authorizeParams(clientId, pkce().challenge, {
        resource: "https://example.com/mcp",
      }),
      store,
      publicBaseUrl,
      publisherEmail: "publisher@thefocus.ai",
      requestUrl: `${publicBaseUrl}/oauth/authorize`,
      approved: true,
    });

    expect(outcome.kind).toBe("error-redirect");
    expect((outcome as { location: string }).location).toContain(
      "invalid_target",
    );
  });
});

describe("token endpoint", () => {
  it("exchanges a code for an access and refresh token", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(store, clientId, challenge);

    const outcome = await handleToken({
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      store,
      publicBaseUrl,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({
      token_type: "Bearer",
      scope: artifactsOAuthScope,
    });
    expect(outcome.body.access_token).toMatch(/^tfai_at_/);
    expect(outcome.body.refresh_token).toMatch(/^tfai_rt_/);
  });

  it("rejects a mismatched PKCE verifier", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const code = await authorizeToCode(store, clientId, pkce().challenge);

    const outcome = await handleToken({
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: pkce().verifier,
      }),
      store,
      publicBaseUrl,
    });

    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses to replay an authorization code", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(store, clientId, challenge);
    const form = () =>
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });

    expect(
      (await handleToken({ form: form(), store, publicBaseUrl })).status,
    ).toBe(200);
    const replay = await handleToken({ form: form(), store, publicBaseUrl });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a code presented by a different client", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const otherClientId = await registeredClient(store);
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(store, clientId, challenge);

    const outcome = await handleToken({
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: otherClientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      store,
      publicBaseUrl,
    });

    expect(outcome.status).toBe(400);
  });

  it("rotates refresh tokens and refuses the old one", async () => {
    const store = new InMemoryOAuthStore();
    const clientId = await registeredClient(store);
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(store, clientId, challenge);
    const first = await handleToken({
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      store,
      publicBaseUrl,
    });
    const refreshToken = first.body.refresh_token as string;

    const refreshed = await handleToken({
      form: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      store,
      publicBaseUrl,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);

    const reuse = await handleToken({
      form: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      store,
      publicBaseUrl,
    });
    expect(reuse.status).toBe(400);
  });
});

describe("Client ID Metadata Documents", () => {
  const clientId = "https://client.example/mcp-client.json";

  it("accepts a document whose client_id equals its URL", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        client_id: clientId,
        client_name: "Example",
        redirect_uris: [redirectUri],
      }),
    ) as unknown as typeof fetch;

    const client = await resolveOAuthClient({
      clientId,
      store: new InMemoryOAuthStore(),
      fetchImpl,
    });
    expect(client.redirectUris).toEqual([redirectUri]);
  });

  it("rejects a document whose client_id disagrees with its URL", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        client_id: "https://client.example/other.json",
        redirect_uris: [redirectUri],
      }),
    ) as unknown as typeof fetch;

    await expect(
      resolveOAuthClient({
        clientId,
        store: new InMemoryOAuthStore(),
        fetchImpl,
      }),
    ).rejects.toThrow("must equal the document URL");
  });

  it("rejects a document with no redirect_uris", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ client_id: clientId }),
    ) as unknown as typeof fetch;

    await expect(
      resolveOAuthClient({
        clientId,
        store: new InMemoryOAuthStore(),
        fetchImpl,
      }),
    ).rejects.toThrow("redirect_uris");
  });
});

describe("registration", () => {
  it("refuses a plaintext http redirect_uri that is not loopback", async () => {
    const outcome = await handleRegister({
      metadata: { redirect_uris: ["http://example.com/callback"] },
      store: new InMemoryOAuthStore(),
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("accepts loopback and custom-scheme redirect URIs", async () => {
    const outcome = await handleRegister({
      metadata: {
        redirect_uris: [
          "http://127.0.0.1:1234/cb",
          "http://localhost:1234/cb",
          "myapp://callback",
          "https://client.example/cb",
        ],
      },
      store: new InMemoryOAuthStore(),
    });
    expect(outcome.status).toBe(201);
  });
});

describe("/mcp with an OAuth access token", () => {
  async function mcpSetup() {
    const oauthStore = new InMemoryOAuthStore();
    const stores = {
      tokenStore: new InMemoryPublisherTokenStore(),
      publicationMetadataStore: new InMemoryPublicationMetadataStore(),
      artifactContentStore: new InMemoryArtifactContentStore(),
      publicationStateStore: new InMemoryPublicationStateStore(),
      livingDocStore: new InMemoryLivingDocMetadataStore(),
      docAssetContentStore: new InMemoryDocAssetContentStore(),
      oauthStore,
    };
    const call = (request: Request) =>
      handleArtifactsMcpRequest({ request, ...stores, publicBaseUrl });

    const clientId = await registeredClient(oauthStore);
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(oauthStore, clientId, challenge);
    const issued = await handleToken({
      form: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      store: oauthStore,
      publicBaseUrl,
    });
    return {
      call,
      oauthStore,
      accessToken: issued.body.access_token as string,
      refreshToken: issued.body.refresh_token as string,
    };
  }

  function rpc(token: string | null, body: unknown): Request {
    return new Request(`${publicBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  };

  it("points an unauthenticated client at the protected resource metadata", async () => {
    const { call } = await mcpSetup();
    const response = await call(rpc(null, initialize));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://artifacts.thefocus.ai/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("authenticates a tool call with an OAuth access token", async () => {
    const { call, accessToken } = await mcpSetup();
    await call(rpc(accessToken, initialize));
    const response = await call(
      rpc(accessToken, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      }),
    );

    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      publisherEmail: "publisher@thefocus.ai",
    });
  });

  it("refuses a refresh token used as a bearer credential", async () => {
    const { call, refreshToken } = await mcpSetup();
    const response = await call(rpc(refreshToken, initialize));
    expect(response.status).toBe(401);
  });

  it("refuses an access token after it is revoked", async () => {
    const { call, accessToken, oauthStore } = await mcpSetup();
    const [record] = await oauthStore.listTokensByPublisherEmail(
      "publisher@thefocus.ai",
    );
    await oauthStore.revokeToken(record!.tokenHash, new Date());

    const response = await call(rpc(accessToken, initialize));
    expect(response.status).toBe(401);
  });

  it("refuses an access token minted for a different resource", async () => {
    const { call, oauthStore } = await mcpSetup();
    const foreign = "tfai_at_foreign-resource-token";
    const { hashOAuthSecret } = await import("../src/oauth/tokens.js");
    await oauthStore.createToken({
      tokenHash: hashOAuthSecret(foreign),
      kind: "access",
      clientId: "someone",
      publisherEmail: "publisher@thefocus.ai",
      scope: artifactsOAuthScope,
      resource: "https://example.com/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await call(rpc(foreign, initialize));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("different resource");
  });
});
