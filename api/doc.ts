import type { IncomingMessage, ServerResponse } from "node:http";

import { createNeonPublisherTokenStore } from "../src/auth.js";
import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../src/http.js";
import { handleLivingDocAgentApiRequest } from "../src/living-doc.js";
import { defaultPublicBaseUrl } from "../src/publication.js";
import { createVercelBlobDocAssetContentStore } from "../src/storage/doc-asset-content.js";
import { createNeonLivingDocMetadataStore } from "../src/storage/living-doc-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handleLivingDocAgentApiRequest({
    request: webRequest,
    store: createNeonLivingDocMetadataStore(),
    tokenStore: createNeonPublisherTokenStore(),
    contentStore: createVercelBlobDocAssetContentStore(),
    publicBaseUrl:
      process.env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
  });
  await writeWebResponseToNodeResponse(webResponse, response);
}
