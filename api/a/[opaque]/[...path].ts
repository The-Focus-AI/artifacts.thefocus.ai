import type { IncomingMessage, ServerResponse } from "node:http";

import { servePublicationNodeRequest } from "../../../src/http.js";
import { VercelBlobArtifactContentStore } from "../../../src/storage/artifact-content.js";
import { createNeonPublicationMetadataStore } from "../../../src/storage/publication-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await servePublicationNodeRequest(request, response, {
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
  });
}
