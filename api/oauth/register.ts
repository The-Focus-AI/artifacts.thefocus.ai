import type { IncomingMessage, ServerResponse } from "node:http";

import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../../src/http.js";
import { handleRegister } from "../../src/oauth/endpoints.js";
import { createNeonOAuthStore } from "../../src/oauth/store.js";
import type { OAuthStore } from "../../src/oauth/store.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webResponse = await handleRegisterRequest(
    await nodeRequestToWebRequest(request),
    { store: createNeonOAuthStore() },
  );
  await writeWebResponseToNodeResponse(webResponse, response);
}

/**
 * Dynamic Client Registration, the compatibility path for clients that do not
 * yet publish a Client ID Metadata Document (STD-009 R2 §3.12).
 */
export async function handleRegisterRequest(
  request: Request,
  deps: { store: OAuthStore },
): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      { error: "invalid_request", error_description: "Use POST." },
      405,
      { allow: "POST" },
    );
  }

  let metadata: { client_name?: unknown; redirect_uris?: unknown };
  try {
    metadata = (await request.json()) as typeof metadata;
  } catch {
    return json(
      {
        error: "invalid_client_metadata",
        error_description: "Body must be JSON client metadata.",
      },
      400,
    );
  }

  const outcome = await handleRegister({ metadata, store: deps.store });
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
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}
