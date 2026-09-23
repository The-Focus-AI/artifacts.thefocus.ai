import type { IncomingMessage, ServerResponse } from "node:http";

import { createNeonPublisherTokenStore } from "../src/auth.js";
import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../src/http.js";
import { handlePwaPushRequest } from "../src/pwa-push.js";
import { createNeonPublicationMetadataStore } from "../src/storage/publication-metadata.js";
import { createNeonPwaPushSubscriptionStore } from "../src/storage/pwa-push-subscriptions.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handlePwaPushHttpRequest(webRequest);
  await writeWebResponseToNodeResponse(webResponse, response);
}

/**
 * Platform Web Push HTTP surface. Subscribe/unsubscribe/vapid are public on
 * the PWA host. Send is Publisher-Token authenticated and fans out with
 * web-push when VAPID_* is set; otherwise it fails closed with 503.
 */
export async function handlePwaPushHttpRequest(
  request: Request,
): Promise<Response> {
  return handlePwaPushRequest({
    request,
    metadataStore: createNeonPublicationMetadataStore(),
    subscriptionStore: createNeonPwaPushSubscriptionStore(),
    tokenStore: createNeonPublisherTokenStore(),
    env: process.env,
  });
}
