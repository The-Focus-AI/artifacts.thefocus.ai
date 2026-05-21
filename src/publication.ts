import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  type ArtifactContentStore,
  VercelBlobArtifactContentStore,
} from "./storage/artifact-content.js";
import {
  createNeonPublicationMetadataStore,
  type PublicationMetadataStore,
} from "./storage/publication-metadata.js";

export const singleFileEntryArtifactPath = "index.html";
const directoryManifestContentType =
  "application/vnd.thefocus.artifact-manifest+json; version=1";
const directoryManifestArtifactPath = "manifest.json";
const directoryManifestKind = "directory-artifact-manifest.v1";

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

export interface PublishDirectoryArtifactInput {
  directoryPath: string;
  entryPage?: string;
  publisherEmail: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  opaqueId?: string;
  manifestRef?: string;
  now?: () => Date;
}

export interface PublishDirectoryArtifactResult {
  opaqueId: string;
  publicationUrlPath: string;
  publicationUrl: string;
  manifestRef: string;
  manifestLocator: string;
  entryArtifactPath: string;
  artifactPaths: string[];
}

interface DirectoryArtifactManifest {
  kind: typeof directoryManifestKind;
  entryArtifactPath: string;
  files: Record<string, DirectoryArtifactManifestFile>;
}

interface DirectoryArtifactManifestFile {
  locator: string;
  contentType: string;
}

export async function publishDirectoryArtifact(
  input: PublishDirectoryArtifactInput,
): Promise<PublishDirectoryArtifactResult> {
  const absoluteDirectoryPath = resolve(input.directoryPath);
  const directoryStats = await stat(absoluteDirectoryPath);
  if (!directoryStats.isDirectory()) {
    throw new Error(
      `Directory Artifact source is not a directory: ${input.directoryPath}`,
    );
  }

  const entryArtifactPath = normalizeEntryPage(input.entryPage ?? "index.html");
  const artifactFiles = await collectDirectoryArtifactFiles(
    absoluteDirectoryPath,
  );
  const entryFile = artifactFiles.find(
    (file) => file.artifactPath === entryArtifactPath,
  );
  if (!entryFile) {
    if (!input.entryPage) {
      throw new Error(
        "Directory Artifacts require a root index.html by default. Pass --entry-page <file.html> to choose a different HTML Entry Page.",
      );
    }
    throw new Error(
      `Entry Page not found in directory Artifact: ${entryArtifactPath}`,
    );
  }
  if (!entryArtifactPath.endsWith(".html")) {
    throw new Error("Directory Artifact Entry Page must be an HTML file.");
  }

  const opaqueId = input.opaqueId ?? createOpaqueId();
  const manifestRef =
    input.manifestRef ?? createManifestRef(Buffer.from(absoluteDirectoryPath));
  const manifest: DirectoryArtifactManifest = {
    kind: directoryManifestKind,
    entryArtifactPath,
    files: {},
  };

  for (const file of artifactFiles) {
    const body = await readFile(file.absolutePath);
    const contentType = contentTypeForArtifactPath(file.artifactPath);
    const written = await input.contentStore.write({
      publicationId: opaqueId,
      manifestRef,
      artifactPath: file.artifactPath,
      body,
      contentType,
    });
    manifest.files[file.artifactPath] = {
      locator: written.url,
      contentType,
    };
  }

  const manifestWritten = await input.contentStore.write({
    publicationId: opaqueId,
    manifestRef,
    artifactPath: directoryManifestArtifactPath,
    body: JSON.stringify(manifest),
    contentType: directoryManifestContentType,
  });

  const publication = await input.metadataStore.create({
    opaqueId,
    publisherEmail: input.publisherEmail,
    activeManifestRef: manifestRef,
    activeArtifactLocator: manifestWritten.url,
    localSourcePath: absoluteDirectoryPath,
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
    manifestLocator: manifestWritten.url,
    entryArtifactPath,
    artifactPaths: Object.keys(manifest.files),
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

  const route = publicationRouteFromUrl(request.url);
  if (!route) {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const publication = await metadataStore.getByOpaqueId(route.opaqueId);
  if (!publication || publication.status !== "active") {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const activeContent = await contentStore.read(
    publication.activeArtifactLocator,
  );
  if (!activeContent) {
    return new Response("Not found", {
      status: 404,
      headers: publicationSafetyHeaders(),
    });
  }

  const content = isDirectoryManifest(activeContent)
    ? await readDirectoryArtifactContent(
        route.artifactPath,
        activeContent,
        contentStore,
      )
    : route.artifactPath === "" ||
        route.artifactPath === singleFileEntryArtifactPath
      ? activeContent
      : null;

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
  return publicationRouteFromUrl(url)?.opaqueId ?? null;
}

export function publicationRouteFromUrl(
  url: string,
): { opaqueId: string; artifactPath: string } | null {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/a\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  return {
    opaqueId: match[1],
    artifactPath: decodeURIComponent(match[2] ?? ""),
  };
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

export async function publishArtifactFromEnvironment(
  sourcePath: string,
  options: {
    publicBaseUrl?: string;
    publisherEmail?: string;
    entryPage?: string;
  } = {},
): Promise<PublishSingleFileArtifactResult | PublishDirectoryArtifactResult> {
  const dependencies = {
    publicBaseUrl:
      options.publicBaseUrl ?? requiredEnv("ARTIFACTS_PUBLIC_BASE_URL"),
    publisherEmail:
      options.publisherEmail ??
      process.env.ARTIFACTS_PUBLISHER_EMAIL ??
      `${process.env.USER ?? "publisher"}@thefocus.ai`,
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
  };

  const sourceStats = await stat(resolve(sourcePath));
  if (sourceStats.isDirectory()) {
    return publishDirectoryArtifact({
      directoryPath: sourcePath,
      entryPage: options.entryPage,
      ...dependencies,
    });
  }
  return publishSingleFileArtifact({ filePath: sourcePath, ...dependencies });
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
  result: Pick<
    PublishSingleFileArtifactResult,
    "publicationUrlPath" | "publicationUrl"
  >,
): string {
  return `Published ${basename(result.publicationUrlPath)} to ${result.publicationUrl}`;
}

async function collectDirectoryArtifactFiles(
  directoryPath: string,
): Promise<Array<{ absolutePath: string; artifactPath: string }>> {
  const files: Array<{ absolutePath: string; artifactPath: string }> = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        absolutePath,
        artifactPath: toArtifactPath(relative(directoryPath, absolutePath)),
      });
    }
  }

  await visit(directoryPath);
  return files.sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
}

function normalizeEntryPage(entryPage: string): string {
  if (isAbsolute(entryPage)) {
    throw new Error(
      "Directory Artifact Entry Page must be inside the directory.",
    );
  }
  const artifactPath = toArtifactPath(entryPage);
  if (artifactPath.startsWith("../") || artifactPath === "..") {
    throw new Error(
      "Directory Artifact Entry Page must be inside the directory.",
    );
  }
  return artifactPath;
}

function toArtifactPath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "").replace(/^\/+/, "");
}

async function readDirectoryArtifactContent(
  requestedArtifactPath: string,
  manifestContent: { body: Buffer },
  contentStore: ArtifactContentStore,
): Promise<{ body: Buffer; contentType: string | null } | null> {
  const manifest = JSON.parse(
    manifestContent.body.toString("utf8"),
  ) as DirectoryArtifactManifest;
  const artifactPath = resolveDirectoryArtifactPath(
    requestedArtifactPath,
    manifest,
  );
  if (!artifactPath) return null;
  const file = manifest.files[artifactPath];
  if (!file) return null;
  return contentStore.read(file.locator);
}

function resolveDirectoryArtifactPath(
  requestedArtifactPath: string,
  manifest: DirectoryArtifactManifest,
): string | null {
  const normalized = toArtifactPath(requestedArtifactPath);
  if (normalized === "") return manifest.entryArtifactPath;
  if (normalized.endsWith("/")) return `${normalized}index.html`;
  if (manifest.files[normalized]) return normalized;
  return null;
}

function isDirectoryManifest(content: { contentType: string | null }): boolean {
  return content.contentType?.startsWith(directoryManifestContentType) ?? false;
}

function contentTypeForArtifactPath(artifactPath: string): string {
  switch (extname(artifactPath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
