import { basename } from "node:path";

import type {
  PublishLivingDocResult,
  PullLivingDocResult,
  RespondLivingDocResult,
  RespondReplyInput,
  RespondSuggestionInput,
} from "./living-doc.js";
import {
  defaultPublicBaseUrl,
  prepareArtifactUpload,
  type PreparedArtifactUpload,
  type PublishArtifactDecision,
  type PublishArtifactResult,
  type RemovePublicationResult,
} from "./publication.js";
import type { LivingDoc } from "./storage/living-doc-metadata.js";
import type { PublicationMetadata } from "./storage/publication-metadata.js";

export interface ArtifactApiClient {
  whoami(token: string): Promise<string>;
  list(token: string): Promise<PublicationMetadata[]>;
  remove(
    token: string,
    publicationUrl: string,
  ): Promise<RemovePublicationResult>;
  publish(
    token: string,
    sourcePath: string,
    options?: RemotePublishOptions,
  ): Promise<PublishArtifactResult & { excludedArtifactPaths?: string[] }>;
}

export interface RemotePublishOptions {
  publicBaseUrl?: string;
  entryPage?: string;
  forceNew?: boolean;
  updatePublicationUrl?: string;
  title?: string;
}

export class HttpArtifactApiClient implements ArtifactApiClient {
  constructor(
    private readonly publicBaseUrl: string = defaultPublicBaseUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async whoami(token: string): Promise<string> {
    const response = await this.request("/api/artifacts?action=whoami", token);
    const body = (await response.json()) as { publisherEmail: string };
    return body.publisherEmail;
  }

  async list(token: string): Promise<PublicationMetadata[]> {
    const response = await this.request("/api/artifacts?action=list", token);
    const body = (await response.json()) as {
      publications: SerializedPublication[];
    };
    return body.publications.map(deserializePublication);
  }

  async remove(
    token: string,
    publicationUrl: string,
  ): Promise<RemovePublicationResult> {
    const response = await this.request("/api/artifacts?action=remove", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicationUrl }),
    });
    return (await response.json()) as RemovePublicationResult;
  }

  async publish(
    token: string,
    sourcePath: string,
    options: RemotePublishOptions = {},
  ): Promise<PublishArtifactResult & { excludedArtifactPaths?: string[] }> {
    const prepared = await prepareArtifactUpload(sourcePath, {
      entryPage: options.entryPage,
    });
    const form = artifactUploadForm(prepared, options);
    const response = await this.request(
      "/api/artifacts?action=publish",
      token,
      {
        method: "POST",
        body: form,
      },
    );
    const body = (await response.json()) as SerializedPublishResult;
    return {
      ...body,
      revisionWindowExpiresAt: new Date(body.revisionWindowExpiresAt),
    };
  }

  private async request(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(new URL(path, this.publicBaseUrl), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        text || `Artifacts API request failed: ${response.status}`,
      );
    }
    return response;
  }
}

export interface LivingDocApiClient {
  publishDoc(
    token: string,
    markdown: string,
    options?: { title?: string },
  ): Promise<PublishLivingDocResult>;
  pullDoc(token: string, opaqueId: string): Promise<PullLivingDocResult>;
  respondDoc(
    token: string,
    opaqueId: string,
    body: {
      suggestions?: RespondSuggestionInput[];
      replies?: RespondReplyInput[];
    },
  ): Promise<RespondLivingDocResult>;
  listDocs(token: string): Promise<LivingDoc[]>;
}

export class HttpLivingDocApiClient implements LivingDocApiClient {
  constructor(
    private readonly publicBaseUrl: string = defaultPublicBaseUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publishDoc(
    token: string,
    markdown: string,
    options: { title?: string } = {},
  ): Promise<PublishLivingDocResult> {
    const response = await this.request("/api/doc?action=publish", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, title: options.title }),
    });
    return (await response.json()) as PublishLivingDocResult;
  }

  async pullDoc(token: string, opaqueId: string): Promise<PullLivingDocResult> {
    const response = await this.request("/api/doc?action=pull", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opaqueId }),
    });
    return (await response.json()) as PullLivingDocResult;
  }

  async respondDoc(
    token: string,
    opaqueId: string,
    body: {
      suggestions?: RespondSuggestionInput[];
      replies?: RespondReplyInput[];
    },
  ): Promise<RespondLivingDocResult> {
    const response = await this.request("/api/doc?action=respond", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opaqueId, ...body }),
    });
    return (await response.json()) as RespondLivingDocResult;
  }

  async listDocs(token: string): Promise<LivingDoc[]> {
    const response = await this.request("/api/doc?action=list", token);
    const body = (await response.json()) as { livingDocs: LivingDoc[] };
    return body.livingDocs;
  }

  private async request(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(new URL(path, this.publicBaseUrl), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        text || `Living Doc API request failed: ${response.status}`,
      );
    }
    return response;
  }
}

export function artifactUploadForm(
  upload: PreparedArtifactUpload,
  options: RemotePublishOptions = {},
): FormData {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      kind: upload.kind,
      localSourcePath: upload.localSourcePath,
      entryArtifactPath: upload.entryArtifactPath,
      excludedArtifactPaths: upload.excludedArtifactPaths,
      publicBaseUrl: options.publicBaseUrl,
      forceNew: options.forceNew ?? false,
      updatePublicationUrl: options.updatePublicationUrl,
      title: options.title,
    }),
  );
  for (const file of upload.files) {
    form.append(
      "files",
      new Blob([new Uint8Array(file.body)], { type: file.contentType }),
      file.artifactPath || basename(upload.localSourcePath),
    );
    form.append("artifactPaths", file.artifactPath);
  }
  return form;
}

interface SerializedPublication extends Omit<
  PublicationMetadata,
  "createdAt" | "updatedAt" | "removedAt" | "revisionWindowExpiresAt"
> {
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  revisionWindowExpiresAt: string | null;
}

interface SerializedPublishResult extends Omit<
  PublishArtifactResult,
  "revisionWindowExpiresAt" | "decision"
> {
  revisionWindowExpiresAt: string;
  decision: PublishArtifactDecision;
  excludedArtifactPaths?: string[];
}

function deserializePublication(
  publication: SerializedPublication,
): PublicationMetadata {
  return {
    ...publication,
    createdAt: new Date(publication.createdAt),
    updatedAt: new Date(publication.updatedAt),
    removedAt: publication.removedAt ? new Date(publication.removedAt) : null,
    revisionWindowExpiresAt: publication.revisionWindowExpiresAt
      ? new Date(publication.revisionWindowExpiresAt)
      : null,
  };
}
