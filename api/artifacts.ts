import type { IncomingMessage, ServerResponse } from "node:http";

import {
  authenticatePublisherToken,
  createNeonPublisherTokenStore,
} from "../src/auth.js";
import { writeWebResponseToNodeResponse } from "../src/http.js";
import {
  defaultPublicBaseUrl,
  publishUploadedArtifact,
  removePublication,
  type PreparedArtifactUpload,
} from "../src/publication.js";
import { InMemoryPublicationStateStore } from "../src/local-config.js";
import { VercelBlobArtifactContentStore } from "../src/storage/artifact-content.js";
import { createNeonPublicationMetadataStore } from "../src/storage/publication-metadata.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handleArtifactsApiRequest(webRequest);
  await writeWebResponseToNodeResponse(webResponse, response);
}

export async function handleArtifactsApiRequest(
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const action =
      url.searchParams.get("action") ??
      url.pathname.split("/").filter(Boolean).at(-1);
    const token = bearerToken(request);
    if (!token)
      return json({ error: "A valid Publisher Token is required" }, 401);

    const tokenStore = createNeonPublisherTokenStore();
    const metadataStore = createNeonPublicationMetadataStore();
    const contentStore = new VercelBlobArtifactContentStore();
    const stateStore = new InMemoryPublicationStateStore();
    const publisherEmail = await authenticatePublisherToken({
      token,
      store: tokenStore,
    });

    if (request.method === "GET" && action === "whoami") {
      return json({ publisherEmail });
    }

    if (request.method === "GET" && action === "list") {
      return json({
        publications: await metadataStore.listByPublisherEmail(publisherEmail),
      });
    }

    if (request.method === "POST" && action === "remove") {
      const body = (await request.json()) as { publicationUrl?: string };
      if (!body.publicationUrl)
        return json({ error: "publicationUrl is required" }, 400);
      return json(
        await removePublication({
          publicationUrl: body.publicationUrl,
          publisherToken: token,
          metadataStore,
          contentStore,
          tokenStore,
          stateStore,
        }),
      );
    }

    if (request.method === "POST" && action === "publish") {
      const { upload, options } = await uploadFromFormData(
        await request.formData(),
      );
      return json(
        await publishUploadedArtifact({
          upload,
          publisherEmail,
          publicBaseUrl: options.publicBaseUrl ?? defaultPublicBaseUrl,
          metadataStore,
          contentStore,
          stateStore,
          forceNew: options.forceNew,
          updatePublicationUrl: options.updatePublicationUrl,
        }),
      );
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
}

async function uploadFromFormData(form: FormData): Promise<{
  upload: PreparedArtifactUpload;
  options: {
    publicBaseUrl?: string;
    forceNew?: boolean;
    updatePublicationUrl?: string;
  };
}> {
  const metadataValue = form.get("metadata");
  if (typeof metadataValue !== "string") {
    throw new Error("metadata is required");
  }
  const metadata = JSON.parse(metadataValue) as {
    kind: PreparedArtifactUpload["kind"];
    localSourcePath: string;
    entryArtifactPath: string;
    excludedArtifactPaths?: string[];
    publicBaseUrl?: string;
    forceNew?: boolean;
    updatePublicationUrl?: string;
  };
  const artifactPaths = form.getAll("artifactPaths").filter(isString);
  const blobs = form.getAll("files").filter(isFile);
  if (artifactPaths.length !== blobs.length) {
    throw new Error("Artifact upload file metadata is incomplete");
  }
  return {
    upload: {
      kind: metadata.kind,
      localSourcePath: metadata.localSourcePath,
      entryArtifactPath: metadata.entryArtifactPath,
      excludedArtifactPaths: metadata.excludedArtifactPaths ?? [],
      files: await Promise.all(
        blobs.map(async (blob, index) => ({
          artifactPath: artifactPaths[index]!,
          body: Buffer.from(await blob.arrayBuffer()),
          contentType: blob.type || "application/octet-stream",
        })),
      ),
    },
    options: {
      publicBaseUrl: metadata.publicBaseUrl,
      forceNew: metadata.forceNew,
      updatePublicationUrl: metadata.updatePublicationUrl,
    },
  };
}

async function nodeRequestToWebRequest(
  request: IncomingMessage,
): Promise<Request> {
  const body = await readRequestBody(request);
  return new Request(nodeRequestUrl(request), {
    method: request.method,
    headers: request.headers as HeadersInit,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

function nodeRequestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  return `${protocol}://${host}${request.url ?? "/"}`;
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isString(value: FormDataEntryValue): value is string {
  return typeof value === "string";
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof value !== "string";
}
