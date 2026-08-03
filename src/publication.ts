import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  authenticatePublisherToken,
  createNeonPublisherTokenStore,
  type PublisherTokenStore,
} from "./auth.js";
import {
  FilePublicationStateStore,
  resolvePublisherToken,
  type PublicationStateStore,
} from "./local-config.js";
import {
  type ArtifactContentStore,
  VercelBlobArtifactContentStore,
} from "./storage/artifact-content.js";
import {
  createNeonPublicationMetadataStore,
  normalizePublicationUrlPath,
  type PublicationMetadataStore,
} from "./storage/publication-metadata.js";

export const singleFileEntryArtifactPath = "index.html";
export const defaultPublicBaseUrl = "https://artifacts.thefocus.ai";
const directoryManifestContentType =
  "application/vnd.thefocus.artifact-manifest+json; version=1";
const directoryManifestArtifactPath = "manifest.json";
const directoryManifestKind = "directory-artifact-manifest.v1";
const maxSingleFileBytes = 25 * 1024 * 1024;
const maxTotalArtifactBytes = 100 * 1024 * 1024;
const maxArtifactFileCount = 1_000;

export function extractHtmlTitle(input: string | Buffer): string | null {
  const s = typeof input === "string" ? input : input.toString("utf8");
  // Match the first <title>...</title>, case-insensitive, capture inner text
  const match = s.match(/<title[^>]*>\s*([\s\S]*?)\s*<\/title>/i);
  if (!match) return null;
  const title = match[1].replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, 200) : null;
}

export interface PublishSingleFileArtifactInput {
  filePath: string;
  publisherEmail: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  opaqueId?: string;
  manifestRef?: string;
  now?: () => Date;
  title?: string;
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
  const fileStats = await stat(absoluteFilePath);
  assertFileWithinSingleFileLimit(
    fileStats.size,
    toArtifactPath(basename(absoluteFilePath)),
  );
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
    title: input.title ?? extractHtmlTitle(html),
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
  title?: string;
}

export interface PublishDirectoryArtifactResult {
  opaqueId: string;
  publicationUrlPath: string;
  publicationUrl: string;
  manifestRef: string;
  manifestLocator: string;
  entryArtifactPath: string;
  artifactPaths: string[];
  excludedArtifactPaths: string[];
}

export type PublishArtifactDecision =
  | "created"
  | "updated"
  | "created-after-expiry"
  | "forced-new"
  | "explicit-update"
  | "created-after-removed-local-state";

export interface PublishArtifactInput {
  sourcePath: string;
  publisherEmail: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  stateStore: PublicationStateStore;
  entryPage?: string;
  forceNew?: boolean;
  updatePublicationUrl?: string;
  opaqueIdFactory?: () => string;
  manifestRefFactory?: (body: Buffer) => string;
  now?: () => Date;
  title?: string;
}

export interface PublishArtifactResult {
  opaqueId: string;
  publicationUrlPath: string;
  publicationUrl: string;
  manifestRef: string;
  activeArtifactLocator: string;
  revisionWindowExpiresAt: Date;
  decision: PublishArtifactDecision;
  artifactPaths: string[];
}

export interface RemovePublicationInput {
  publicationUrl: string;
  /** A Publisher Token to authenticate. Omit when `publisherEmail` is given. */
  publisherToken?: string;
  /**
   * An already-authenticated Publisher, for surfaces that established identity
   * some other way — an OAuth access token on `/mcp`, for instance.
   */
  publisherEmail?: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  tokenStore?: PublisherTokenStore;
  stateStore: PublicationStateStore;
}

export interface RemovePublicationResult {
  opaqueId: string;
  publicationUrl: string;
  status: "removed" | "not-found";
  deletedLocators: string[];
  clearedLocalSourcePath: string | null;
}

export type PreparedArtifactUploadKind = "single-file" | "directory";

export interface PreparedArtifactUploadFile {
  artifactPath: string;
  body: Buffer;
  contentType: string;
}

export interface PreparedArtifactUpload {
  kind: PreparedArtifactUploadKind;
  localSourcePath: string;
  entryArtifactPath: string;
  files: PreparedArtifactUploadFile[];
  excludedArtifactPaths: string[];
}

export interface PublishUploadedArtifactInput {
  upload: PreparedArtifactUpload;
  publisherEmail: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  stateStore: PublicationStateStore;
  forceNew?: boolean;
  updatePublicationUrl?: string;
  opaqueIdFactory?: () => string;
  now?: () => Date;
  title?: string;
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
  const {
    files: artifactFiles,
    excludedArtifactPaths: dirExcludedArtifactPaths,
  } = await collectDirectoryArtifactFiles(absoluteDirectoryPath);
  const entryFile = artifactFiles.find(
    (file: { absolutePath: string; artifactPath: string; size: number }) =>
      file.artifactPath === entryArtifactPath,
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

  const derivedTitle = entryFile
    ? extractHtmlTitle(await readFile(entryFile.absolutePath))
    : null;

  const publication = await input.metadataStore.create({
    opaqueId,
    publisherEmail: input.publisherEmail,
    activeManifestRef: manifestRef,
    activeArtifactLocator: manifestWritten.url,
    localSourcePath: absoluteDirectoryPath,
    revisionWindowExpiresAt: null,
    title: input.title ?? derivedTitle,
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
    excludedArtifactPaths: dirExcludedArtifactPaths,
  };
}

export async function publishArtifact(
  input: PublishArtifactInput,
): Promise<PublishArtifactResult> {
  const now = input.now?.() ?? new Date();
  const localSourcePath = await realpath(input.sourcePath);
  const revisionWindowExpiresAt = addMinutes(now, 15);
  const packaged = await packageArtifactSource(input, localSourcePath);

  if (input.updatePublicationUrl) {
    const opaqueId = opaqueIdFromPublicationUrl(input.updatePublicationUrl);
    if (!opaqueId) throw new Error("--update requires a Publication URL.");
    return updateExistingPublication({
      ...input,
      localSourcePath,
      opaqueId,
      packaged,
      revisionWindowExpiresAt,
      decision: "explicit-update",
    });
  }

  const existingState = await input.stateStore.get(localSourcePath);
  if (!input.forceNew && existingState) {
    const publication = await input.metadataStore.getByOpaqueId(
      existingState.opaqueId,
    );
    if (publication?.status === "active") {
      if (existingState.revisionWindowExpiresAt.getTime() >= now.getTime()) {
        return updateExistingPublication({
          ...input,
          localSourcePath,
          opaqueId: existingState.opaqueId,
          packaged,
          revisionWindowExpiresAt,
          decision: "updated",
        });
      }
      return createFreshPublication({
        ...input,
        localSourcePath,
        packaged,
        revisionWindowExpiresAt,
        decision: "created-after-expiry",
      });
    }
    return createFreshPublication({
      ...input,
      localSourcePath,
      packaged,
      revisionWindowExpiresAt,
      decision: "created-after-removed-local-state",
    });
  }

  return createFreshPublication({
    ...input,
    localSourcePath,
    packaged,
    revisionWindowExpiresAt,
    decision: input.forceNew ? "forced-new" : "created",
  });
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

  const redirectLocation = trailingSlashRedirectLocation(
    request.url,
    route.artifactPath,
  );
  if (redirectLocation) {
    return new Response(null, {
      status: 308,
      headers: publicationSafetyHeaders({ location: redirectLocation }),
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

/**
 * A root Publication or View is served at both `/a/{id}` and `/a/{id}/`, but
 * only the trailing-slash form lets relative links inside the served document
 * resolve under the id instead of the site root. Returns the Location to
 * redirect a bare root request to, or null when the request is already
 * canonical or addresses a nested path.
 */
export function trailingSlashRedirectLocation(
  requestUrl: string,
  nestedPath: string,
): string | null {
  if (nestedPath !== "") return null;
  const url = new URL(requestUrl);
  if (url.pathname.endsWith("/")) return null;
  return `${url.pathname}/${url.search}`;
}

export function absolutePublicationUrl(
  publicBaseUrl: string,
  publicationUrlPath: string,
): string {
  const base = publicBaseUrl.endsWith("/")
    ? publicBaseUrl
    : `${publicBaseUrl}/`;
  const path = normalizePublicationUrlPath(publicationUrlPath).replace(
    /^\/+/,
    "",
  );
  return new URL(path, base).toString();
}

export function createOpaqueId(): string {
  return randomBytes(8).toString("base64url");
}

function createManifestRef(body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `${Date.now().toString(36)}-${hash}-${randomUUID().slice(0, 8)}`;
}

export async function publishSingleFileArtifactWithPublisherToken(input: {
  filePath: string;
  publisherToken: string;
  publicBaseUrl: string;
  metadataStore: PublicationMetadataStore;
  contentStore: ArtifactContentStore;
  tokenStore: PublisherTokenStore;
}): Promise<PublishSingleFileArtifactResult> {
  const publisherEmail = await authenticatePublisherToken({
    token: input.publisherToken,
    store: input.tokenStore,
  });
  return publishSingleFileArtifact({
    filePath: input.filePath,
    publicBaseUrl: input.publicBaseUrl,
    publisherEmail,
    metadataStore: input.metadataStore,
    contentStore: input.contentStore,
  });
}

export async function publishArtifactFromEnvironment(
  sourcePath: string,
  options: {
    publicBaseUrl?: string;
    entryPage?: string;
    env?: NodeJS.ProcessEnv;
    configDir?: string;
    forceNew?: boolean;
    updatePublicationUrl?: string;
    title?: string;
  } = {},
): Promise<PublishArtifactResult> {
  const env = options.env ?? process.env;
  const token = await resolvePublisherToken({
    env,
    configDir: options.configDir,
  });
  if (!token.token) throw new Error("A valid Publisher Token is required");
  const publisherEmail = await authenticatePublisherToken({
    token: token.token,
    store: createNeonPublisherTokenStore(),
  });
  return publishArtifact({
    sourcePath,
    publicBaseUrl:
      options.publicBaseUrl ??
      env.ARTIFACTS_PUBLIC_BASE_URL ??
      defaultPublicBaseUrl,
    publisherEmail,
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
    stateStore: new FilePublicationStateStore(options.configDir),
    entryPage: options.entryPage,
    forceNew: options.forceNew,
    updatePublicationUrl: options.updatePublicationUrl,
    title: options.title,
  });
}

export async function prepareArtifactUpload(
  sourcePath: string,
  options: { entryPage?: string } = {},
): Promise<PreparedArtifactUpload> {
  const localSourcePath = await realpath(sourcePath);
  const sourceStats = await stat(localSourcePath);
  if (sourceStats.isDirectory()) {
    const entryArtifactPath = normalizeEntryPage(
      options.entryPage ?? "index.html",
    );
    const { files, excludedArtifactPaths } =
      await collectDirectoryArtifactFiles(localSourcePath);
    const entryFile = files.find(
      (file) => file.artifactPath === entryArtifactPath,
    );
    if (!entryFile) {
      if (!options.entryPage) {
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
    return {
      kind: "directory",
      localSourcePath,
      entryArtifactPath,
      files: await Promise.all(
        files.map(async (file) => ({
          artifactPath: file.artifactPath,
          body: await readFile(file.absolutePath),
          contentType: contentTypeForArtifactPath(file.artifactPath),
        })),
      ),
      excludedArtifactPaths,
    };
  }

  assertFileWithinSingleFileLimit(
    sourceStats.size,
    toArtifactPath(basename(localSourcePath)),
  );
  return {
    kind: "single-file",
    localSourcePath,
    entryArtifactPath: singleFileEntryArtifactPath,
    files: [
      {
        artifactPath: singleFileEntryArtifactPath,
        body: await readFile(localSourcePath),
        contentType: "text/html; charset=utf-8",
      },
    ],
    excludedArtifactPaths: [],
  };
}

/** A file supplied as content rather than read from the local filesystem. */
export interface InlineArtifactFile {
  artifactPath: string;
  /** Base64 for binary files. Exactly one of `contentBase64` or `text`. */
  contentBase64?: string;
  text?: string;
  contentType?: string;
}

export interface PrepareInlineArtifactUploadInput {
  /** Shorthand for a one-page Artifact: the HTML becomes `index.html`. */
  html?: string;
  files?: InlineArtifactFile[];
  entryPage?: string;
  /**
   * Recorded as the Publication's Local Source. Inline uploads have no local
   * path, so callers pass a marker naming the surface they came from.
   */
  sourceLabel?: string;
}

/**
 * Build an upload from content held in memory, for surfaces that cannot read
 * the Publisher's filesystem. The same preflight limits as
 * `prepareArtifactUpload` apply — they are the service's limits, not the
 * CLI's.
 */
export function prepareInlineArtifactUpload(
  input: PrepareInlineArtifactUploadInput,
): PreparedArtifactUpload {
  const localSourcePath = input.sourceLabel ?? "inline:artifact";
  const hasFiles = (input.files?.length ?? 0) > 0;
  if (input.html === undefined && !hasFiles) {
    throw new Error("Publishing requires either html or at least one file.");
  }
  if (input.html !== undefined && hasFiles) {
    throw new Error(
      "Pass either html (a single page) or files (a directory Artifact), not both.",
    );
  }

  if (input.html !== undefined) {
    const body = Buffer.from(input.html, "utf-8");
    assertFileWithinSingleFileLimit(
      body.byteLength,
      singleFileEntryArtifactPath,
    );
    return {
      kind: "single-file",
      localSourcePath,
      entryArtifactPath: singleFileEntryArtifactPath,
      files: [
        {
          artifactPath: singleFileEntryArtifactPath,
          body,
          contentType: "text/html; charset=utf-8",
        },
      ],
      excludedArtifactPaths: [],
    };
  }

  const seen = new Set<string>();
  const files = (input.files ?? []).map((file) => {
    const artifactPath = normalizeInlineArtifactPath(file.artifactPath);
    if (seen.has(artifactPath)) {
      throw new Error(`Duplicate Artifact Path in upload: ${artifactPath}`);
    }
    seen.add(artifactPath);
    if (file.contentBase64 !== undefined && file.text !== undefined) {
      throw new Error(
        `Artifact file ${artifactPath} must set either contentBase64 or text, not both.`,
      );
    }
    const body =
      file.text !== undefined
        ? Buffer.from(file.text, "utf-8")
        : Buffer.from(file.contentBase64 ?? "", "base64");
    assertFileWithinSingleFileLimit(body.byteLength, artifactPath);
    return {
      artifactPath,
      body,
      contentType: file.contentType ?? contentTypeForArtifactPath(artifactPath),
    };
  });

  assertDirectoryArtifactWithinPreflightLimits(
    files.map((file) => ({
      absolutePath: file.artifactPath,
      artifactPath: file.artifactPath,
      size: file.body.byteLength,
    })),
  );

  const entryArtifactPath = normalizeEntryPage(input.entryPage ?? "index.html");
  if (!entryArtifactPath.endsWith(".html")) {
    throw new Error("Directory Artifact Entry Page must be an HTML file.");
  }
  if (!files.some((file) => file.artifactPath === entryArtifactPath)) {
    throw new Error(
      input.entryPage
        ? `Entry Page not found in the uploaded files: ${entryArtifactPath}`
        : "Directory Artifacts require a root index.html by default. Pass entryPage to choose a different HTML Entry Page.",
    );
  }

  return {
    kind: "directory",
    localSourcePath,
    entryArtifactPath,
    files,
    excludedArtifactPaths: [],
  };
}

function requireTokenStore(
  store: PublisherTokenStore | undefined,
): PublisherTokenStore {
  if (!store) {
    throw new Error("A Publisher Token store is required to authenticate.");
  }
  return store;
}

function normalizeInlineArtifactPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("Each uploaded file requires an artifactPath.");
  }
  if (isAbsolute(rawPath) || rawPath.startsWith("/")) {
    throw new Error(`Artifact Path must be relative: ${rawPath}`);
  }
  const artifactPath = toArtifactPath(rawPath.replace(/\\/g, "/"));
  const segments = artifactPath.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Artifact Path must not escape the Artifact: ${rawPath}`);
  }
  if (segments.some((segment) => segment === "")) {
    throw new Error(`Artifact Path has an empty segment: ${rawPath}`);
  }
  return artifactPath;
}

export async function publishUploadedArtifact(
  input: PublishUploadedArtifactInput,
): Promise<PublishArtifactResult & { excludedArtifactPaths: string[] }> {
  const now = input.now?.() ?? new Date();
  const revisionWindowExpiresAt = addMinutes(now, 15);
  const packaged = {
    async writeForPublication(opaqueId: string) {
      return writeUploadedArtifactContent({
        upload: input.upload,
        contentStore: input.contentStore,
        publicationId: opaqueId,
      });
    },
  };
  const baseInput = {
    sourcePath: input.upload.localSourcePath,
    publisherEmail: input.publisherEmail,
    publicBaseUrl: input.publicBaseUrl,
    metadataStore: input.metadataStore,
    contentStore: input.contentStore,
    stateStore: input.stateStore,
    opaqueIdFactory: input.opaqueIdFactory,
    forceNew: input.forceNew,
    updatePublicationUrl: input.updatePublicationUrl,
    title: input.title,
  } satisfies PublishArtifactInput;

  const result = input.updatePublicationUrl
    ? await updateExistingPublication({
        ...baseInput,
        localSourcePath: input.upload.localSourcePath,
        opaqueId: opaqueIdFromPublicationUrl(input.updatePublicationUrl) ?? "",
        packaged,
        revisionWindowExpiresAt,
        decision: "explicit-update",
      })
    : await publishUploadedArtifactByState({
        ...baseInput,
        localSourcePath: input.upload.localSourcePath,
        packaged,
        revisionWindowExpiresAt,
        currentTime: now,
      });
  return {
    ...result,
    excludedArtifactPaths: input.upload.excludedArtifactPaths,
  };
}

export async function publishSingleFileArtifactFromEnvironment(
  filePath: string,
  options: { publicBaseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PublishSingleFileArtifactResult> {
  const env = options.env ?? process.env;
  const token = await resolvePublisherToken({ env });
  return publishSingleFileArtifactWithPublisherToken({
    filePath,
    publicBaseUrl:
      options.publicBaseUrl ??
      env.ARTIFACTS_PUBLIC_BASE_URL ??
      defaultPublicBaseUrl,
    publisherToken: token.token ?? requiredEnv("THEFOCUS_ARTIFACTS_TOKEN"),
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
    tokenStore: createNeonPublisherTokenStore(),
  });
}

export async function removePublication(
  input: RemovePublicationInput,
): Promise<RemovePublicationResult> {
  // Removal is deliberately team-wide: any authenticated Publisher may remove
  // any Publication. See the Removal tests, which assert exactly that.
  if (!input.publisherEmail) {
    await authenticatePublisherToken({
      token: input.publisherToken,
      store: requireTokenStore(input.tokenStore),
    });
  }
  const opaqueId = opaqueIdFromPublicationUrl(input.publicationUrl);
  if (!opaqueId) throw new Error("remove requires a Publication URL.");

  const publication = await input.metadataStore.getByOpaqueId(opaqueId);
  if (!publication || publication.status !== "active") {
    return {
      opaqueId,
      publicationUrl: input.publicationUrl,
      status: "not-found",
      deletedLocators: [],
      clearedLocalSourcePath: null,
    };
  }

  const locators = await activePublicationLocators(
    publication.activeArtifactLocator,
    input.contentStore,
  );
  await input.metadataStore.markRemoved(opaqueId);
  await input.contentStore.delete(locators);
  if (publication.localSourcePath) {
    await input.stateStore.clear(publication.localSourcePath);
  }

  return {
    opaqueId,
    publicationUrl: input.publicationUrl,
    status: "removed",
    deletedLocators: locators,
    clearedLocalSourcePath: publication.localSourcePath,
  };
}

export async function removePublicationFromEnvironment(
  publicationUrl: string,
  options: { env?: NodeJS.ProcessEnv; configDir?: string } = {},
): Promise<RemovePublicationResult> {
  const token = await resolvePublisherToken({
    env: options.env,
    configDir: options.configDir,
  });
  if (!token.token) throw new Error("A valid Publisher Token is required");
  return removePublication({
    publicationUrl,
    publisherToken: token.token,
    metadataStore: createNeonPublicationMetadataStore(),
    contentStore: new VercelBlobArtifactContentStore(),
    tokenStore: createNeonPublisherTokenStore(),
    stateStore: new FilePublicationStateStore(options.configDir),
  });
}

export function removePublicationSummary(
  result: Pick<RemovePublicationResult, "publicationUrl" | "status">,
): string {
  return result.status === "removed"
    ? `Removed ${result.publicationUrl}`
    : `Publication not found or already removed: ${result.publicationUrl}`;
}

export function singleFilePublishSummary(
  result: Pick<
    PublishSingleFileArtifactResult,
    "publicationUrlPath" | "publicationUrl"
  > & {
    revisionWindowExpiresAt?: Date;
    decision?: PublishArtifactDecision;
    excludedArtifactPaths?: string[];
  },
  options: { verbose?: boolean } = {},
): string {
  return publishArtifactSummary(result, options);
}

export function publishArtifactSummary(
  result: Pick<
    PublishSingleFileArtifactResult,
    "publicationUrlPath" | "publicationUrl"
  > & {
    revisionWindowExpiresAt?: Date;
    decision?: PublishArtifactDecision;
    excludedArtifactPaths?: string[];
  },
  options: { verbose?: boolean } = {},
): string {
  const action = result.decision?.includes("update") ? "Updated" : "Published";
  const suffix = result.revisionWindowExpiresAt
    ? ` (Revision Window until ${result.revisionWindowExpiresAt.toISOString()})`
    : "";
  const lines = [
    `${action} ${basename(result.publicationUrlPath)} to ${result.publicationUrl}${suffix}`,
  ];
  const excluded = result.excludedArtifactPaths ?? [];
  if (excluded.length > 0) {
    lines.push(
      `Warning: ${excluded.length} files or directories were excluded by packaging safety rules. Re-run with --verbose to see details.`,
    );
    if (options.verbose) {
      lines.push("Excluded paths:", ...excluded.map((path) => `- ${path}`));
    }
  }
  return lines.join("\n");
}

interface PackagedArtifact {
  manifestRef: string;
  activeArtifactLocator: string;
  artifactPaths: string[];
  excludedArtifactPaths: string[];
  derivedTitle?: string | null;
}

async function packageArtifactSource(
  input: Pick<
    PublishArtifactInput,
    "sourcePath" | "entryPage" | "contentStore" | "manifestRefFactory"
  >,
  localSourcePath: string,
): Promise<
  PackagedArtifact & {
    writeForPublication: (opaqueId: string) => Promise<PackagedArtifact>;
  }
> {
  return {
    manifestRef: "pending",
    activeArtifactLocator: "pending",
    artifactPaths: [],
    excludedArtifactPaths: [],
    derivedTitle: undefined,
    async writeForPublication(publicationId: string) {
      const sourceStats = await stat(localSourcePath);
      if (sourceStats.isDirectory()) {
        return writeDirectoryArtifactContent({
          directoryPath: localSourcePath,
          entryPage: input.entryPage,
          contentStore: input.contentStore,
          publicationId,
          manifestRefFactory: input.manifestRefFactory,
        });
      }
      return writeSingleFileArtifactContent({
        filePath: localSourcePath,
        contentStore: input.contentStore,
        publicationId,
        manifestRefFactory: input.manifestRefFactory,
      });
    },
  };
}

async function publishUploadedArtifactByState(
  input: PublishArtifactInput & {
    localSourcePath: string;
    packaged: {
      writeForPublication: (opaqueId: string) => Promise<PackagedArtifact>;
    };
    revisionWindowExpiresAt: Date;
    currentTime: Date;
  },
): Promise<PublishArtifactResult> {
  const existingState = await input.stateStore.get(input.localSourcePath);
  if (!input.forceNew && existingState) {
    const publication = await input.metadataStore.getByOpaqueId(
      existingState.opaqueId,
    );
    if (publication?.status === "active") {
      if (
        existingState.revisionWindowExpiresAt.getTime() >=
        input.currentTime.getTime()
      ) {
        return updateExistingPublication({
          ...input,
          opaqueId: existingState.opaqueId,
          decision: "updated",
        });
      }
      return createFreshPublication({
        ...input,
        decision: "created-after-expiry",
      });
    }
    return createFreshPublication({
      ...input,
      decision: "created-after-removed-local-state",
    });
  }

  return createFreshPublication({
    ...input,
    decision: input.forceNew ? "forced-new" : "created",
  });
}

async function createFreshPublication(
  input: PublishArtifactInput & {
    localSourcePath: string;
    packaged: {
      writeForPublication: (opaqueId: string) => Promise<PackagedArtifact>;
    };
    revisionWindowExpiresAt: Date;
    decision: PublishArtifactDecision;
  },
): Promise<PublishArtifactResult> {
  const opaqueId = input.opaqueIdFactory?.() ?? createOpaqueId();
  const packaged = await input.packaged.writeForPublication(opaqueId);
  const title = input.title ?? packaged.derivedTitle ?? null;
  const publication = await input.metadataStore.create({
    opaqueId,
    publisherEmail: input.publisherEmail,
    activeManifestRef: packaged.manifestRef,
    activeArtifactLocator: packaged.activeArtifactLocator,
    localSourcePath: input.localSourcePath,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
    title,
  });
  const publicationUrl = absolutePublicationUrl(
    input.publicBaseUrl,
    publication.publicationUrlPath,
  );
  await input.stateStore.set({
    localSourcePath: input.localSourcePath,
    opaqueId,
    publicationUrl,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
  });
  return {
    opaqueId,
    publicationUrlPath: publication.publicationUrlPath,
    publicationUrl,
    manifestRef: packaged.manifestRef,
    activeArtifactLocator: packaged.activeArtifactLocator,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
    decision: input.decision,
    artifactPaths: packaged.artifactPaths,
  };
}

async function updateExistingPublication(
  input: PublishArtifactInput & {
    localSourcePath: string;
    opaqueId: string;
    packaged: {
      writeForPublication: (opaqueId: string) => Promise<PackagedArtifact>;
    };
    revisionWindowExpiresAt: Date;
    decision: PublishArtifactDecision;
  },
): Promise<PublishArtifactResult> {
  const existing = await input.metadataStore.getByOpaqueId(input.opaqueId);
  if (!existing || existing.status !== "active") {
    throw new Error(
      "Publication URL cannot be updated because it is not active.",
    );
  }
  const oldLocators = await activePublicationLocators(
    existing.activeArtifactLocator,
    input.contentStore,
  );
  const packaged = await input.packaged.writeForPublication(input.opaqueId);
  const title = Object.hasOwn(input, "title")
    ? (input.title ?? null)
    : (packaged.derivedTitle ?? undefined);
  const publication = await input.metadataStore.update(input.opaqueId, {
    activeManifestRef: packaged.manifestRef,
    activeArtifactLocator: packaged.activeArtifactLocator,
    localSourcePath: input.localSourcePath,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
    ...(title !== undefined ? { title } : {}),
  });
  if (!publication) throw new Error("Publication URL cannot be updated.");
  await input.contentStore.delete(oldLocators);
  const publicationUrl = absolutePublicationUrl(
    input.publicBaseUrl,
    publication.publicationUrlPath,
  );
  await input.stateStore.set({
    localSourcePath: input.localSourcePath,
    opaqueId: input.opaqueId,
    publicationUrl,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
  });
  return {
    opaqueId: input.opaqueId,
    publicationUrlPath: publication.publicationUrlPath,
    publicationUrl,
    manifestRef: packaged.manifestRef,
    activeArtifactLocator: packaged.activeArtifactLocator,
    revisionWindowExpiresAt: input.revisionWindowExpiresAt,
    decision: input.decision,
    artifactPaths: packaged.artifactPaths,
  };
}

async function writeUploadedArtifactContent(input: {
  upload: PreparedArtifactUpload;
  contentStore: ArtifactContentStore;
  publicationId: string;
}): Promise<PackagedArtifact> {
  const manifestRef = createManifestRef(
    Buffer.concat(input.upload.files.map((file) => file.body)),
  );
  if (input.upload.kind === "single-file") {
    const file = input.upload.files[0];
    if (!file) throw new Error("Single-file Artifact upload had no file.");
    const written = await input.contentStore.write({
      publicationId: input.publicationId,
      manifestRef,
      artifactPath: singleFileEntryArtifactPath,
      body: file.body,
      contentType: file.contentType,
    });
    return {
      manifestRef,
      activeArtifactLocator: written.url,
      artifactPaths: [singleFileEntryArtifactPath],
      excludedArtifactPaths: input.upload.excludedArtifactPaths,
      derivedTitle: extractHtmlTitle(file.body),
    };
  }

  const entryFile = input.upload.files.find(
    (f) => f.artifactPath === input.upload.entryArtifactPath,
  );
  const manifest: DirectoryArtifactManifest = {
    kind: directoryManifestKind,
    entryArtifactPath: input.upload.entryArtifactPath,
    files: {},
  };
  for (const file of input.upload.files) {
    const written = await input.contentStore.write({
      publicationId: input.publicationId,
      manifestRef,
      artifactPath: file.artifactPath,
      body: file.body,
      contentType: file.contentType,
    });
    manifest.files[file.artifactPath] = {
      locator: written.url,
      contentType: file.contentType,
    };
  }
  const manifestWritten = await input.contentStore.write({
    publicationId: input.publicationId,
    manifestRef,
    artifactPath: directoryManifestArtifactPath,
    body: JSON.stringify(manifest),
    contentType: directoryManifestContentType,
  });
  return {
    manifestRef,
    activeArtifactLocator: manifestWritten.url,
    artifactPaths: Object.keys(manifest.files),
    excludedArtifactPaths: input.upload.excludedArtifactPaths,
    derivedTitle: entryFile ? extractHtmlTitle(entryFile.body) : null,
  };
}

async function writeSingleFileArtifactContent(input: {
  filePath: string;
  contentStore: ArtifactContentStore;
  publicationId: string;
  manifestRefFactory?: (body: Buffer) => string;
}): Promise<PackagedArtifact> {
  const html = await readFile(input.filePath);
  const manifestRef =
    input.manifestRefFactory?.(html) ?? createManifestRef(html);
  const written = await input.contentStore.write({
    publicationId: input.publicationId,
    manifestRef,
    artifactPath: singleFileEntryArtifactPath,
    body: html,
    contentType: "text/html; charset=utf-8",
  });
  return {
    manifestRef,
    activeArtifactLocator: written.url,
    artifactPaths: [singleFileEntryArtifactPath],
    excludedArtifactPaths: [],
    derivedTitle: extractHtmlTitle(html),
  };
}

async function writeDirectoryArtifactContent(input: {
  directoryPath: string;
  entryPage?: string;
  contentStore: ArtifactContentStore;
  publicationId: string;
  manifestRefFactory?: (body: Buffer) => string;
}): Promise<PackagedArtifact> {
  const entryArtifactPath = normalizeEntryPage(input.entryPage ?? "index.html");
  const { files: artifactFiles, excludedArtifactPaths: dirExcluded } =
    await collectDirectoryArtifactFiles(input.directoryPath);
  const entryFile = artifactFiles.find(
    (file: { absolutePath: string; artifactPath: string; size: number }) =>
      file.artifactPath === entryArtifactPath,
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
  const entryFileBytes = await readFile(entryFile.absolutePath);
  const manifestRef =
    input.manifestRefFactory?.(Buffer.from(input.directoryPath)) ??
    createManifestRef(Buffer.from(input.directoryPath));
  const manifest: DirectoryArtifactManifest = {
    kind: directoryManifestKind,
    entryArtifactPath,
    files: {},
  };
  for (const file of artifactFiles) {
    const body = await readFile(file.absolutePath);
    const contentType = contentTypeForArtifactPath(file.artifactPath);
    const written = await input.contentStore.write({
      publicationId: input.publicationId,
      manifestRef,
      artifactPath: file.artifactPath,
      body,
      contentType,
    });
    manifest.files[file.artifactPath] = { locator: written.url, contentType };
  }
  const manifestWritten = await input.contentStore.write({
    publicationId: input.publicationId,
    manifestRef,
    artifactPath: directoryManifestArtifactPath,
    body: JSON.stringify(manifest),
    contentType: directoryManifestContentType,
  });
  return {
    manifestRef,
    activeArtifactLocator: manifestWritten.url,
    artifactPaths: Object.keys(manifest.files),
    excludedArtifactPaths: dirExcluded,
    derivedTitle: extractHtmlTitle(entryFileBytes),
  };
}

function shouldExcludeArtifactPath(
  artifactPath: string,
  isDirectory: boolean,
): boolean {
  const parts = artifactPath.split("/").filter(Boolean);
  const name = parts.at(-1) ?? artifactPath;
  if (parts[0] === ".well-known") return false;
  if (parts.some((part) => part.startsWith("."))) return true;
  if (excludedDirectoryNames.has(name)) return true;
  if (!isDirectory && excludedFileNames.has(name)) return true;
  if (!isDirectory && excludedFileExtensions.has(extname(name).toLowerCase())) {
    return true;
  }
  return false;
}

function assertFileWithinSingleFileLimit(
  size: number,
  artifactPath: string,
): void {
  if (size > maxSingleFileBytes) {
    throw new Error(
      `Artifact file ${artifactPath} exceeds the 25 MB single-file limit.`,
    );
  }
}

function assertDirectoryArtifactWithinPreflightLimits(
  files: Array<{ absolutePath: string; artifactPath: string; size: number }>,
): void {
  if (files.length > maxArtifactFileCount) {
    throw new Error(
      `Directory Artifact has ${files.length} files and exceeds the 1,000 file limit.`,
    );
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > maxTotalArtifactBytes) {
    throw new Error(
      `Directory Artifact total size exceeds the 100 MB total Artifact limit.`,
    );
  }
}

const excludedDirectoryNames = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".cache",
  "cache",
  ".turbo",
  "coverage",
  "dist-cache",
  "__pycache__",
]);

const excludedFileNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".yarnrc",
  "id_rsa",
  "id_ed25519",
]);

const excludedFileExtensions = new Set([".pem", ".key", ".p12", ".pfx"]);

async function activePublicationLocators(
  activeArtifactLocator: string,
  contentStore: ArtifactContentStore,
): Promise<string[]> {
  const activeContent = await contentStore.read(activeArtifactLocator);
  if (!activeContent || !isDirectoryManifest(activeContent)) {
    return [activeArtifactLocator];
  }
  const manifest = JSON.parse(
    activeContent.body.toString("utf8"),
  ) as DirectoryArtifactManifest;
  return [
    activeArtifactLocator,
    ...Object.values(manifest.files).map((file) => file.locator),
  ];
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

async function collectDirectoryArtifactFiles(directoryPath: string): Promise<{
  files: Array<{ absolutePath: string; artifactPath: string; size: number }>;
  excludedArtifactPaths: string[];
}> {
  const files: Array<{
    absolutePath: string;
    artifactPath: string;
    size: number;
  }> = [];
  const excludedArtifactPaths: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(currentDirectory, entry.name);
      const artifactPath = toArtifactPath(
        relative(directoryPath, absolutePath),
      );
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symlinks are not supported in directory Artifacts: ${artifactPath}`,
        );
      }
      if (shouldExcludeArtifactPath(artifactPath, entry.isDirectory())) {
        excludedArtifactPaths.push(
          entry.isDirectory() ? `${artifactPath}/` : artifactPath,
        );
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStats = await stat(absolutePath);
      assertFileWithinSingleFileLimit(fileStats.size, artifactPath);
      files.push({
        absolutePath,
        artifactPath,
        size: fileStats.size,
      });
    }
  }

  await visit(directoryPath);
  assertDirectoryArtifactWithinPreflightLimits(files);
  return {
    files: files.sort((a, b) => a.artifactPath.localeCompare(b.artifactPath)),
    excludedArtifactPaths: excludedArtifactPaths.sort((a, b) =>
      a.localeCompare(b),
    ),
  };
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
