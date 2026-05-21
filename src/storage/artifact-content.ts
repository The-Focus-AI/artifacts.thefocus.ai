import { del, put } from "@vercel/blob";

export interface ArtifactContentWrite {
  publicationId: string;
  manifestRef: string;
  artifactPath: string;
  body: BlobContentBody;
  contentType?: string;
}

export type BlobContentBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream;

export interface ArtifactContentLocation {
  blobPath: string;
  url: string;
}

export interface ArtifactContentRead {
  body: Buffer;
  contentType: string | null;
}

export interface ArtifactContentStore {
  write(input: ArtifactContentWrite): Promise<ArtifactContentLocation>;
  read(blobPath: string): Promise<ArtifactContentRead | null>;
  delete(blobPaths: string[]): Promise<void>;
}

export interface BlobClient {
  put(
    path: string,
    body: BlobContentBody,
    options: { access: "public"; contentType?: string; addRandomSuffix: false },
  ): Promise<{ url: string }>;
  fetch(url: string): Promise<Response>;
  del(urlOrPath: string | string[]): Promise<void>;
}

export class InMemoryArtifactContentStore implements ArtifactContentStore {
  private readonly entries = new Map<
    string,
    ArtifactContentRead & { url: string }
  >();

  async write(input: ArtifactContentWrite): Promise<ArtifactContentLocation> {
    const blobPath = artifactBlobPath(
      input.publicationId,
      input.manifestRef,
      input.artifactPath,
    );
    const url = `memory://${blobPath}`;
    this.entries.set(blobPath, {
      body: await bodyToBuffer(input.body),
      contentType: input.contentType ?? null,
      url,
    });
    return { blobPath, url };
  }

  async read(blobPath: string): Promise<ArtifactContentRead | null> {
    const entry = this.entries.get(blobPath);
    return entry
      ? { body: Buffer.from(entry.body), contentType: entry.contentType }
      : null;
  }

  async delete(blobPaths: string[]): Promise<void> {
    for (const blobPath of blobPaths) {
      this.entries.delete(blobPath);
    }
  }
}

export class VercelBlobArtifactContentStore implements ArtifactContentStore {
  private readonly pathToUrl = new Map<string, string>();

  constructor(private readonly blob: BlobClient = defaultBlobClient) {}

  async write(input: ArtifactContentWrite): Promise<ArtifactContentLocation> {
    const blobPath = artifactBlobPath(
      input.publicationId,
      input.manifestRef,
      input.artifactPath,
    );
    const result = await this.blob.put(blobPath, input.body, {
      access: "public",
      contentType: input.contentType,
      addRandomSuffix: false,
    });
    this.pathToUrl.set(blobPath, result.url);
    return { blobPath, url: result.url };
  }

  async read(blobPath: string): Promise<ArtifactContentRead | null> {
    const url = this.pathToUrl.get(blobPath) ?? blobPath;
    const response = await this.blob.fetch(url);
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Unable to read Artifact content ${blobPath}: ${response.status}`,
      );
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type"),
    };
  }

  async delete(blobPaths: string[]): Promise<void> {
    if (blobPaths.length === 0) return;
    await this.blob.del(blobPaths);
    for (const blobPath of blobPaths) {
      this.pathToUrl.delete(blobPath);
    }
  }
}

export function artifactBlobPath(
  publicationId: string,
  manifestRef: string,
  artifactPath: string,
): string {
  const safeArtifactPath = artifactPath.replace(/^\/+/, "");
  return ["artifacts", publicationId, manifestRef, safeArtifactPath].join("/");
}

const defaultBlobClient: BlobClient = {
  async put(path, body, options) {
    return put(path, body as Parameters<typeof put>[1], options);
  },
  fetch,
  del,
};

async function bodyToBuffer(body: BlobContentBody): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body))
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  const chunks: Buffer[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
