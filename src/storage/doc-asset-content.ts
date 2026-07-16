import { del, get, put } from "@vercel/blob";
import { extname } from "node:path";

import type {
  BlobClient,
  BlobContentBody,
  ArtifactContentRead,
} from "./artifact-content.js";

export interface DocAssetWriteInput {
  opaqueId: string;
  assetPath: string;
  body: BlobContentBody;
  contentType?: string;
}

export interface DocAssetLocation {
  blobPath: string;
  /** Vercel Blob (or memory) locator for read/delete. */
  locator: string;
}

export interface DocAssetContentStore {
  write(input: DocAssetWriteInput): Promise<DocAssetLocation>;
  read(
    opaqueId: string,
    assetPath: string,
  ): Promise<ArtifactContentRead | null>;
  delete(locators: string[]): Promise<void>;
}

/**
 * Normalize a hosted Doc Asset path segment.
 * Rejects empty paths, absolute paths, and `..` traversal in the URL path
 * (local `..` is resolved at collect time into a stable assetPath).
 */
export function normalizeDocAssetPath(assetPath: string): string | null {
  const trimmed = assetPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

export function docAssetBlobPath(opaqueId: string, assetPath: string): string {
  const normalized = normalizeDocAssetPath(assetPath);
  if (!normalized) {
    throw new Error(`Invalid Doc Asset path: ${assetPath}`);
  }
  return ["living-docs", opaqueId, normalized].join("/");
}

export function contentTypeForDocAssetPath(assetPath: string): string {
  switch (extname(assetPath).toLowerCase()) {
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

export class InMemoryDocAssetContentStore implements DocAssetContentStore {
  private readonly entries = new Map<
    string,
    ArtifactContentRead & { locator: string }
  >();

  async write(input: DocAssetWriteInput): Promise<DocAssetLocation> {
    const blobPath = docAssetBlobPath(input.opaqueId, input.assetPath);
    const locator = `memory://${blobPath}`;
    this.entries.set(blobPath, {
      body: await bodyToBuffer(input.body),
      contentType:
        input.contentType ?? contentTypeForDocAssetPath(input.assetPath),
      locator,
    });
    return { blobPath, locator };
  }

  async read(
    opaqueId: string,
    assetPath: string,
  ): Promise<ArtifactContentRead | null> {
    const normalized = normalizeDocAssetPath(assetPath);
    if (!normalized) return null;
    const blobPath = docAssetBlobPath(opaqueId, normalized);
    const entry = this.entries.get(blobPath);
    return entry
      ? { body: Buffer.from(entry.body), contentType: entry.contentType }
      : null;
  }

  async delete(locators: string[]): Promise<void> {
    for (const locator of locators) {
      for (const [blobPath, entry] of this.entries.entries()) {
        if (entry.locator === locator || blobPath === locator) {
          this.entries.delete(blobPath);
        }
      }
    }
  }

  /** Test helper: list blob paths for an opaque id. */
  listBlobPaths(opaqueId: string): string[] {
    const prefix = `living-docs/${opaqueId}/`;
    return [...this.entries.keys()].filter((path) => path.startsWith(prefix));
  }
}

export interface DocAssetBlobClient {
  put: BlobClient["put"];
  get(
    pathname: string,
    options: { access: "public" },
  ): Promise<{
    statusCode: number;
    stream: ReadableStream<Uint8Array> | null;
    blob: { contentType: string | null };
  } | null>;
  del: BlobClient["del"];
}

export class VercelBlobDocAssetContentStore implements DocAssetContentStore {
  constructor(
    private readonly blob: DocAssetBlobClient = defaultDocAssetBlobClient,
  ) {}

  async write(input: DocAssetWriteInput): Promise<DocAssetLocation> {
    const blobPath = docAssetBlobPath(input.opaqueId, input.assetPath);
    const contentType =
      input.contentType ?? contentTypeForDocAssetPath(input.assetPath);
    const result = await this.blob.put(blobPath, input.body, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });
    return { blobPath, locator: result.url };
  }

  async read(
    opaqueId: string,
    assetPath: string,
  ): Promise<ArtifactContentRead | null> {
    const normalized = normalizeDocAssetPath(assetPath);
    if (!normalized) return null;
    const blobPath = docAssetBlobPath(opaqueId, normalized);
    const result = await this.blob.get(blobPath, { access: "public" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return {
      body: await streamToBuffer(result.stream),
      contentType:
        result.blob.contentType ?? contentTypeForDocAssetPath(normalized),
    };
  }

  async delete(locators: string[]): Promise<void> {
    if (locators.length === 0) return;
    await this.blob.del(locators);
  }
}

export function createVercelBlobDocAssetContentStore(): VercelBlobDocAssetContentStore {
  return new VercelBlobDocAssetContentStore();
}

const defaultDocAssetBlobClient: DocAssetBlobClient = {
  async put(path, body, options) {
    return put(path, body as Parameters<typeof put>[1], options);
  },
  get,
  del,
};

async function bodyToBuffer(body: BlobContentBody): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body))
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  return streamToBuffer(body);
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
