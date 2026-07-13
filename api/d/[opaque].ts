import type { IncomingMessage, ServerResponse } from "node:http";

import { writeWebResponseToNodeResponse } from "../../src/http.js";
import { serveLivingDocViewRequest } from "../../src/living-doc.js";
import { createNeonLivingDocMetadataStore } from "../../src/storage/living-doc-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webResponse = await serveLivingDocViewRequest({
    request: new Request(livingDocViewRequestUrl(request), {
      method: request.method,
      headers: request.headers as HeadersInit,
    }),
    store: createNeonLivingDocMetadataStore(),
  });
  await writeWebResponseToNodeResponse(webResponse, response);
}

function livingDocViewRequestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  const query = (request as IncomingMessage & { query?: { opaque?: unknown } })
    .query;
  const opaque =
    typeof query?.opaque === "string"
      ? query.opaque
      : Array.isArray(query?.opaque) && typeof query.opaque[0] === "string"
        ? query.opaque[0]
        : pathTail(request.url ?? "/");
  const search = new URL(request.url ?? "/", "https://localhost").search;
  return `${protocol}://${host}/d/${opaque}${search}`;
}

function pathTail(url: string): string {
  const pathname = new URL(url, "https://localhost").pathname;
  return pathname.split("/").filter(Boolean).at(-1) ?? "";
}
