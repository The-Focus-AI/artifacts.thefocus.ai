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

  const token = bearerToken(request);
  if (!token) {
    return unauthorized(
      "invalid_request",
      "A Publisher Token is required. Send it as: Authorization: Bearer tfai_mcp_... Create one with: artifacts token create --for mcp",
    );
  }

  let publisherEmail: string;
  try {
    const record = await authenticatePublisherTokenRecord({
      token,
      store: input.tokenStore,
    });
    publisherEmail = record.publisherEmail;
  } catch (error) {
    if (
      error instanceof InvalidPublisherTokenError ||
      error instanceof RevokedPublisherTokenError
    ) {
      return unauthorized("invalid_token", error.message);
    }
    throw error;
  }

  const context: McpToolContext = {
    publisherEmail,
    publisherToken: token,
    publicBaseUrl: input.publicBaseUrl ?? defaultPublicBaseUrl,
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

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * 401s carry `WWW-Authenticate` so a client can tell "you sent no credential"
 * apart from "your credential is bad" without parsing prose.
 */
function unauthorized(error: string, description: string): Response {
  return problem(401, error, description, {
    "www-authenticate": `Bearer error="${error}", error_description="${headerSafe(description)}"`,
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
