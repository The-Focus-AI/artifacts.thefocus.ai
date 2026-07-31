import type { IncomingMessage, ServerResponse } from "node:http";

import { createNeonPublisherTokenStore } from "../src/auth.js";
import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../src/http.js";
import { InMemoryPublicationStateStore } from "../src/local-config.js";
import { handleArtifactsMcpRequest } from "../src/mcp/server.js";
import { defaultPublicBaseUrl } from "../src/publication.js";
import { VercelBlobArtifactContentStore } from "../src/storage/artifact-content.js";
import { createVercelBlobDocAssetContentStore } from "../src/storage/doc-asset-content.js";
import { createNeonLivingDocMetadataStore } from "../src/storage/living-doc-metadata.js";
import { createNeonPublicationMetadataStore } from "../src/storage/publication-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handleArtifactsMcpRequest({
    request: webRequest,
    tokenStore: createNeonPublisherTokenStore(),
    publicationMetadataStore: createNeonPublicationMetadataStore(),
    artifactContentStore: new VercelBlobArtifactContentStore(),
    // Local Source state is a CLI concept: the Revision Window cannot apply to
    // a surface with no local filesystem, so updates here are always explicit.
    publicationStateStore: new InMemoryPublicationStateStore(),
    livingDocStore: createNeonLivingDocMetadataStore(),
    docAssetContentStore: createVercelBlobDocAssetContentStore(),
    publicBaseUrl:
      process.env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
  });
  await writeWebResponseToNodeResponse(webResponse, response);
}
