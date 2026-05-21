import type { IncomingMessage, ServerResponse } from "node:http";

import {
  servePublicationRequest,
  type ServePublicationInput,
} from "./publication.js";

export async function writeWebResponseToNodeResponse(
  webResponse: Response,
  nodeResponse: ServerResponse,
): Promise<void> {
  nodeResponse.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  const body = Buffer.from(await webResponse.arrayBuffer());
  nodeResponse.end(body);
}

export async function servePublicationNodeRequest(
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
  dependencies: Omit<ServePublicationInput, "request">,
): Promise<void> {
  const request = new Request(publicationRequestUrl(nodeRequest), {
    method: nodeRequest.method,
  });
  const response = await servePublicationRequest({
    request,
    ...dependencies,
  });
  await writeWebResponseToNodeResponse(response, nodeResponse);
}

export function publicationRequestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  const opaqueId = opaqueIdFromVercelRequest(request);
  return `${protocol}://${host}/a/${opaqueId}`;
}

function opaqueIdFromVercelRequest(request: IncomingMessage): string {
  const queryOpaque = (
    request as IncomingMessage & { query?: { opaque?: unknown } }
  ).query?.opaque;
  if (typeof queryOpaque === "string") return queryOpaque;
  if (Array.isArray(queryOpaque) && typeof queryOpaque[0] === "string") {
    return queryOpaque[0];
  }

  const pathname = new URL(request.url ?? "/", "https://localhost").pathname;
  return pathname.split("/").filter(Boolean).at(-1) ?? "";
}
