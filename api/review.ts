import type { IncomingMessage, ServerResponse } from "node:http";

import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../src/http.js";
import { handleReviewApiRequest } from "../src/living-doc.js";
import { createNeonLivingDocMetadataStore } from "../src/storage/living-doc-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handleReviewApiRequest({
    request: webRequest,
    store: createNeonLivingDocMetadataStore(),
  });
  await writeWebResponseToNodeResponse(webResponse, response);
}
