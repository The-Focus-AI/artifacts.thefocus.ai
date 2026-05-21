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
  const artifactPath = artifactPathFromVercelRequest(request);
  return `${protocol}://${host}/a/${artifactPath}`;
}

function artifactPathFromVercelRequest(request: IncomingMessage): string {
  const queryOpaque = (
    request as IncomingMessage & {
      query?: { opaque?: unknown; path?: unknown };
    }
  ).query?.opaque;
  const queryPath = (
    request as IncomingMessage & {
      query?: { opaque?: unknown; path?: unknown };
    }
  ).query?.path;
  if (typeof queryOpaque === "string") {
    return [queryOpaque, queryPathFromVercelCatchAll(queryPath)]
      .filter(Boolean)
      .join("/");
  }
  if (Array.isArray(queryOpaque) && typeof queryOpaque[0] === "string") {
    return [queryOpaque[0], queryPathFromVercelCatchAll(queryPath)]
      .filter(Boolean)
      .join("/");
  }

  const pathname = new URL(request.url ?? "/", "https://localhost").pathname;
  const apiPrefix = "/api/a/";
  if (pathname.startsWith(apiPrefix)) return pathname.slice(apiPrefix.length);
  const publicPrefix = "/a/";
  if (pathname.startsWith(publicPrefix))
    return pathname.slice(publicPrefix.length);
  return pathname.split("/").filter(Boolean).at(-1) ?? "";
}

function queryPathFromVercelCatchAll(path: unknown): string {
  if (Array.isArray(path)) return path.filter(isString).join("/");
  if (typeof path === "string") return path;
  return "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
