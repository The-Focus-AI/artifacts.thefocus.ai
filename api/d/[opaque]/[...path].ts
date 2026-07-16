import type { IncomingMessage, ServerResponse } from "node:http";

import { serveLivingDocViewNodeRequest } from "../../../src/http.js";
import { createVercelBlobDocAssetContentStore } from "../../../src/storage/doc-asset-content.js";
import { createNeonLivingDocMetadataStore } from "../../../src/storage/living-doc-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await serveLivingDocViewNodeRequest(request, response, {
    store: createNeonLivingDocMetadataStore(),
    contentStore: createVercelBlobDocAssetContentStore(),
  });
}
