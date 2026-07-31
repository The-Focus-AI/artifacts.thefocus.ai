import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  authenticatePublisherTokenRecord,
  InvalidPublisherTokenError,
  RevokedPublisherTokenError,
  type PublisherTokenStore,
} from "../auth.js";
import type { PublicationStateStore } from "../local-config.js";
import { defaultPublicBaseUrl } from "../publication.js";
import type { ArtifactContentStore } from "../storage/artifact-content.js";
import type { DocAssetContentStore } from "../storage/doc-asset-content.js";
import type { LivingDocMetadataStore } from "../storage/living-doc-metadata.js";
import type { PublicationMetadataStore } from "../storage/publication-metadata.js";
import { mcpResourceIdentifier } from "../oauth/metadata.js";
import type { OAuthStore } from "../oauth/store.js";
import { isOAuthAccessToken, verifyOAuthAccessToken } from "../oauth/tokens.js";
import { registerToolOnMcpServer, type McpToolContext } from "./spec.js";
import { artifactsMcpTools } from "./tools.js";

export const artifactsMcpServerName = "artifacts.thefocus.ai";
export const artifactsMcpServerVersion = "1.0.0";

export interface ArtifactsMcpDependencies {
  tokenStore: PublisherTokenStore;
  publicationMetadataStore: PublicationMetadataStore;
  artifactContentStore: ArtifactContentStore;
  publicationStateStore: PublicationStateStore;
  livingDocStore: LivingDocMetadataStore;
  docAssetContentStore: DocAssetContentStore;
  /** Present once the OAuth login flow is deployed; absent means token-only. */
  oauthStore?: OAuthStore;
  publicBaseUrl?: string;
}

export function buildArtifactsMcpServer(context: McpToolContext): McpServer {
  const server = new McpServer(
    { name: artifactsMcpServerName, version: artifactsMcpServerVersion },
    {
      capabilities: { tools: {} },
      instructions: [
        "Publish agent-generated HTML as unlisted Artifacts, and Markdown as Living Docs a human can edit and comment on.",
        "publish_artifact returns a Publication URL to hand to a person; keep that URL if you may need update_artifact later.",
        "The Living Doc loop is publish_doc, then pull_doc to read Reviewer feedback, then respond_doc to propose changes. Repeat.",
      ].join(" "),
    },
  );
  for (const spec of artifactsMcpTools) {
    registerToolOnMcpServer(server, spec, context);
  }
  return server;
}

export interface HandleArtifactsMcpRequestInput extends ArtifactsMcpDependencies {
  request: Request;
}

/**
 * The `/mcp` endpoint. Stateless per request — Vercel can suspend the instance
 * between calls — and in JSON response mode, so a whole reply fits in one
 * buffered HTTP response rather than an SSE stream the function would have to
 * hold open.
 */
export async function handleArtifactsMcpRequest(
  input: HandleArtifactsMcpRequestInput,
): Promise<Response> {
  const { request } = input;

  if (request.method === "GET") {
    // Server-initiated SSE requires a session this endpoint does not keep.
    return problem(405, "method_not_allowed", "Use POST for MCP requests.", {
      allow: "POST, DELETE",
    });
  }
  if (request.method === "DELETE") {
    // Session teardown is a no-op when there is no session.
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return problem(405, "method_not_allowed", "Use POST for MCP requests.", {
      allow: "POST, DELETE",
    });
  }

  const publicBaseUrl = input.publicBaseUrl ?? defaultPublicBaseUrl;
  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    publicBaseUrl,
  ).toString();

  const token = bearerToken(request);
  if (!token) {
    return unauthorized(
      "invalid_request",
      "Authorization required. Log in through OAuth, or send a Publisher Token as: Authorization: Bearer tfai_mcp_...",
      resourceMetadataUrl,
    );
  }

  const authenticated = await authenticateMcpToken({
    token,
    tokenStore: input.tokenStore,
    oauthStore: input.oauthStore,
    resource: mcpResourceIdentifier(publicBaseUrl),
  });
  if (!authenticated.ok) {
    return unauthorized(
      "invalid_token",
      authenticated.message,
      resourceMetadataUrl,
    );
  }
  const publisherEmail = authenticated.publisherEmail;

  const context: McpToolContext = {
    publisherEmail,
    publicBaseUrl,
    tokenStore: input.tokenStore,
    publicationMetadataStore: input.publicationMetadataStore,
    artifactContentStore: input.artifactContentStore,
    publicationStateStore: input.publicationStateStore,
    livingDocStore: input.livingDocStore,
    docAssetContentStore: input.docAssetContentStore,
  };

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildArtifactsMcpServer(context);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

type McpAuthResult =
  | { ok: true; publisherEmail: string }
  | { ok: false; message: string };

/**
 * Two credentials are accepted: an OAuth access token minted by our own
 * authorization server (the browser login), and a Publisher Token (the CLI's
 * credential, pasted into a client that supports headers). The prefix decides
 * which, so a malformed token is never checked against both stores.
 */
async function authenticateMcpToken(input: {
  token: string;
  tokenStore: PublisherTokenStore;
  oauthStore?: OAuthStore;
  resource: string;
}): Promise<McpAuthResult> {
  if (isOAuthAccessToken(input.token)) {
    if (!input.oauthStore) {
      return { ok: false, message: "OAuth is not enabled on this deployment." };
    }
    const verified = await verifyOAuthAccessToken({
      token: input.token,
      store: input.oauthStore,
      resource: input.resource,
    });
    if (verified.ok) {
      return { ok: true, publisherEmail: verified.record.publisherEmail };
    }
    return { ok: false, message: oauthFailureMessage(verified.reason) };
  }

  try {
    const record = await authenticatePublisherTokenRecord({
      token: input.token,
      store: input.tokenStore,
    });
    return { ok: true, publisherEmail: record.publisherEmail };
  } catch (error) {
    if (
      error instanceof InvalidPublisherTokenError ||
      error instanceof RevokedPublisherTokenError
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

function oauthFailureMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "The access token has expired. Refresh it and retry.";
    case "revoked":
      return "This access token was revoked.";
    case "wrong-audience":
      return "This access token was issued for a different resource.";
    case "wrong-kind":
      return "A refresh token cannot be used to call this endpoint.";
    default:
      return "Unknown access token.";
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * 401s carry `WWW-Authenticate` so a client can tell "you sent no credential"
 * apart from "your credential is bad" without parsing prose.
 */
/**
 * 401s carry `WWW-Authenticate` with a `resource_metadata` pointer, which is
 * how an MCP client discovers where to log in (RFC 9728). Clients that only
 * paste a token ignore it; clients that can run the OAuth flow follow it.
 */
function unauthorized(
  error: string,
  description: string,
  resourceMetadataUrl: string,
): Response {
  return problem(401, error, description, {
    "www-authenticate":
      `Bearer error="${error}", error_description="${headerSafe(description)}", ` +
      `resource_metadata="${resourceMetadataUrl}"`,
  });
}

/**
 * Header values are ByteStrings: anything outside Latin-1 throws when the
 * Response is constructed. Quotes would also end the parameter early.
 */
function headerSafe(value: string): string {
  return value
    .replace(/"/g, "'")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function problem(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { "content-type": "application/json", ...headers },
    },
  );
}
