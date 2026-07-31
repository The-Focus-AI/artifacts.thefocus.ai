import type { IncomingMessage, ServerResponse } from "node:http";

import { nodeRequestUrl } from "../../src/http.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../../src/oauth/metadata.js";
import { defaultPublicBaseUrl } from "../../src/publication.js";

/**
 * Serves both discovery documents. Which one depends on the path, so the two
 * `.well-known` routes can share a single function.
 */
export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const publicBaseUrl =
    process.env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl;
  const { pathname } = new URL(nodeRequestUrl(request));
  const body = pathname.includes("oauth-authorization-server")
    ? authorizationServerMetadata(publicBaseUrl)
    : protectedResourceMetadata(publicBaseUrl);

  response.writeHead(200, {
    "content-type": "application/json",
    // Discovery documents are public and stable; let clients cache them.
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body, null, 2));
}
