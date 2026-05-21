import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  type ArtifactContentStore,
  VercelBlobArtifactContentStore,
} from "./storage/artifact-content.js";
import {
  createNeonPublicationMetadataStore,
  type PublicationMetadataStore,
} from "./storage/publication-metadata.js";

export const singleFileEntryArtifactPath = "index.html";

export interface PublishSingleFileArtifactInput {
  filePath: string;
  publisherEmail: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  opaqueId?: string;
  manifestRef?: string;
  now?: () => Date;
}

export interface PublishSingleFileArtifactResult {
  opaqueId: string;
  publicationUrlPath: string;
  publicationUrl: string;
  manifestRef: string;
  artifactLocator: string;
}

export async function publishSingleFileArtifact(
  input: PublishSingleFileArtifactInput,
): Promise<PublishSingleFileArtifactResult> {
  const absoluteFilePath = resolve(input.filePath);
  const html = await readFile(absoluteFilePath);
  const opaqueId = input.opaqueId ?? createOpaqueId();
  const manifestRef = input.manifestRef ?? createManifestRef(html);
  const written = await input.contentStore.write({
    publicationId: opaqueId,
    manifestRef,
    artifactPath: singleFileEntryArtifactPath,
    body: html,
    contentType: "text/html; charset=utf-8",
  });

  const publication = await input.metadataStore.create({
    opaqueId,
    publisherEmail: input.publisherEmail,
    activeManifestRef: manifestRef,
    activeArtifactLocator: written.url,
    localSourcePath: absoluteFilePath,
    revisionWindowExpiresAt: null,
  });

  return {
    opaqueId,
    publicationUrlPath: publication.publicationUrlPath,
    publicationUrl: absolutePublicationUrl(
      input.publicBaseUrl,
      publication.publicationUrlPath,
    ),
    manifestRef,
    artifactLocator: written.url,
  };
}

export interface ServePublicationInput {
  request: Request;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
}

export async function servePublicationRequest({
  request,
  metadataStore,
  contentStore,
}: ServePublicationInput): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: publicationSafetyHeaders(),
    });
  }

  const opaqueId = opaqueIdFromPublicationUrl(request.url);
  if (!opaqueId) {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const publication = await metadataStore.getByOpaqueId(opaqueId);
  if (!publication || publication.status !== "active") {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const content = await contentStore.read(publication.activeArtifactLocator);
  if (!content) {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const headers = publicationSafetyHeaders({
    "content-type": content.contentType ?? "text/html; charset=utf-8",
  });
  return new Response(
    request.method === "HEAD" ? null : new Uint8Array(content.body),
    {
      status: 200,
      headers,
    },
  );
}

export function publicationSafetyHeaders(headers: HeadersInit = {}): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...headers,
  });
}

export function opaqueIdFromPublicationUrl(url: string): string | null {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/a\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}

export function absolutePublicationUrl(
  publicBaseUrl: string,
  publicationUrlPath: string,
): string {
  const base = publicBaseUrl.endsWith("/")
    ? publicBaseUrl
    : `${publicBaseUrl}/`;
  return new URL(publicationUrlPath.replace(/^\/+/, ""), base).toString();
}

export function createOpaqueId(): string {
  return randomBytes(8).toString("base64url");
}

function createManifestRef(body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `${Date.now().toString(36)}-${hash}-${randomUUID().slice(0, 8)}`;
}

export async function publishSingleFileArtifactFromEnvironment(
  filePath: string,
  options: { publicBaseUrl?: string; publisherEmail?: string } = {},
): Promise<PublishSingleFileArtifactResult> {
  return publishSingleFileArtifact({
    filePath,
    publicBaseUrl:
      options.publicBaseUrl ?? requiredEnv("ARTIFACTS_PUBLIC_BASE_URL"),
    publisherEmail:
      options.publisherEmail ??
      process.env.ARTIFACTS_PUBLISHER_EMAIL ??
      `${process.env.USER ?? "publisher"}@thefocus.ai`,
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
  });
}

export function singleFilePublishSummary(
  result: PublishSingleFileArtifactResult,
): string {
  return `Published ${basename(result.publicationUrlPath)} to ${result.publicationUrl}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
