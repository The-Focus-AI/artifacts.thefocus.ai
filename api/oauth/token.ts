import type { IncomingMessage, ServerResponse } from "node:http";

import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../../src/http.js";
import { handleToken } from "../../src/oauth/endpoints.js";
import { createNeonOAuthStore } from "../../src/oauth/store.js";
import type { OAuthStore } from "../../src/oauth/store.js";
import { defaultPublicBaseUrl } from "../../src/publication.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webResponse = await handleTokenRequest(
    await nodeRequestToWebRequest(request),
    {
      store: createNeonOAuthStore(),
      publicBaseUrl:
        process.env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
    },
  );
  await writeWebResponseToNodeResponse(webResponse, response);
}

export async function handleTokenRequest(
  request: Request,
  deps: { store: OAuthStore; publicBaseUrl: string },
): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      { error: "invalid_request", error_description: "Use POST." },
      405,
      { allow: "POST" },
    );
  }
  const outcome = await handleToken({
    form: new URLSearchParams(await request.text()),
    store: deps.store,
    publicBaseUrl: deps.publicBaseUrl,
  });
  return json(outcome.body, outcome.status);
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Token responses must never be cached (RFC 6749 §5.1).
      "cache-control": "no-store",
      pragma: "no-cache",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}
