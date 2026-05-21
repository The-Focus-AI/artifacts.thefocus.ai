import { neon } from "@neondatabase/serverless";

export type PublicationStatus = "active" | "removed";

export interface PublicationMetadata {
  opaqueId: string;
  publicationUrlPath: string;
  publisherEmail: string;
  status: PublicationStatus;
  activeManifestRef: string;
  activeArtifactLocator: string;
  localSourcePath: string | null;
  revisionWindowExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}

export interface CreatePublicationInput {
  opaqueId: string;
  publisherEmail: string;
  status?: PublicationStatus;
  activeManifestRef: string;
  activeArtifactLocator: string;
  localSourcePath?: string | null;
  revisionWindowExpiresAt?: Date | null;
}

export interface UpdatePublicationInput {
  activeManifestRef?: string;
  activeArtifactLocator?: string;
  localSourcePath?: string | null;
  revisionWindowExpiresAt?: Date | null;
}

export interface PublicationMetadataStore {
  create(input: CreatePublicationInput): Promise<PublicationMetadata>;
  getByOpaqueId(opaqueId: string): Promise<PublicationMetadata | null>;
  update(
    opaqueId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationMetadata | null>;
  markRemoved(opaqueId: string): Promise<PublicationMetadata | null>;
  listByPublisherEmail(publisherEmail: string): Promise<PublicationMetadata[]>;
}

export interface ClockOptions {
  now?: () => Date;
}

export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class InMemoryPublicationMetadataStore implements PublicationMetadataStore {
  private readonly rows = new Map<string, PublicationMetadata>();
  private readonly now: () => Date;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreatePublicationInput): Promise<PublicationMetadata> {
    const timestamp = this.now();
    const row: PublicationMetadata = {
      opaqueId: input.opaqueId,
      publicationUrlPath: publicationUrlPathFor(input.opaqueId),
      publisherEmail: input.publisherEmail,
      status: input.status ?? "active",
      activeManifestRef: input.activeManifestRef,
      activeArtifactLocator: input.activeArtifactLocator,
      localSourcePath: input.localSourcePath ?? null,
      revisionWindowExpiresAt: input.revisionWindowExpiresAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      removedAt: null,
    };
    this.rows.set(row.opaqueId, row);
    return clonePublication(row);
  }

  async getByOpaqueId(opaqueId: string): Promise<PublicationMetadata | null> {
    const row = this.rows.get(opaqueId);
    return row ? clonePublication(row) : null;
  }

  async update(
    opaqueId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationMetadata | null> {
    const row = this.rows.get(opaqueId);
    if (!row) return null;

    const next: PublicationMetadata = {
      ...row,
      activeManifestRef: input.activeManifestRef ?? row.activeManifestRef,
      activeArtifactLocator:
        input.activeArtifactLocator ?? row.activeArtifactLocator,
      localSourcePath: Object.hasOwn(input, "localSourcePath")
        ? (input.localSourcePath ?? null)
        : row.localSourcePath,
      revisionWindowExpiresAt: Object.hasOwn(input, "revisionWindowExpiresAt")
        ? (input.revisionWindowExpiresAt ?? null)
        : row.revisionWindowExpiresAt,
      updatedAt: this.now(),
    };
    this.rows.set(opaqueId, next);
    return clonePublication(next);
  }

  async markRemoved(opaqueId: string): Promise<PublicationMetadata | null> {
    const row = this.rows.get(opaqueId);
    if (!row) return null;
    const timestamp = this.now();
    const next: PublicationMetadata = {
      ...row,
      status: "removed",
      removedAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.set(opaqueId, next);
    return clonePublication(next);
  }

  async listByPublisherEmail(
    publisherEmail: string,
  ): Promise<PublicationMetadata[]> {
    return [...this.rows.values()]
      .filter((row) => row.publisherEmail === publisherEmail)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(clonePublication);
  }
}

export class PostgresPublicationMetadataStore implements PublicationMetadataStore {
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: ClockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreatePublicationInput): Promise<PublicationMetadata> {
    const timestamp = this.now();
    const result = await this.sql.query<PublicationRow>(
      `
        insert into publications (
          opaque_id,
          publication_url_path,
          publisher_email,
          status,
          active_manifest_ref,
          active_artifact_locator,
          local_source_path,
          revision_window_expires_at,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning *
      `,
      [
        input.opaqueId,
        publicationUrlPathFor(input.opaqueId),
        input.publisherEmail,
        input.status ?? "active",
        input.activeManifestRef,
        input.activeArtifactLocator,
        input.localSourcePath ?? null,
        input.revisionWindowExpiresAt ?? null,
        timestamp,
        timestamp,
      ],
    );
    return mapPublicationRow(result.rows[0]);
  }

  async getByOpaqueId(opaqueId: string): Promise<PublicationMetadata | null> {
    const result = await this.sql.query<PublicationRow>(
      "select * from publications where opaque_id = $1",
      [opaqueId],
    );
    return result.rows[0] ? mapPublicationRow(result.rows[0]) : null;
  }

  async update(
    opaqueId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationMetadata | null> {
    const existing = await this.getByOpaqueId(opaqueId);
    if (!existing) return null;

    const result = await this.sql.query<PublicationRow>(
      `
        update publications
        set active_manifest_ref = $2,
            active_artifact_locator = $3,
            revision_window_expires_at = $4,
            local_source_path = $5,
            updated_at = $6
        where opaque_id = $1
        returning *
      `,
      [
        opaqueId,
        input.activeManifestRef ?? existing.activeManifestRef,
        input.activeArtifactLocator ?? existing.activeArtifactLocator,
        Object.hasOwn(input, "revisionWindowExpiresAt")
          ? (input.revisionWindowExpiresAt ?? null)
          : existing.revisionWindowExpiresAt,
        Object.hasOwn(input, "localSourcePath")
          ? (input.localSourcePath ?? null)
          : existing.localSourcePath,
        this.now(),
      ],
    );
    return result.rows[0] ? mapPublicationRow(result.rows[0]) : null;
  }

  async markRemoved(opaqueId: string): Promise<PublicationMetadata | null> {
    const timestamp = this.now();
    const result = await this.sql.query<PublicationRow>(
      `
        update publications
        set status = 'removed', removed_at = $2, updated_at = $2
        where opaque_id = $1
        returning *
      `,
      [opaqueId, timestamp],
    );
    return result.rows[0] ? mapPublicationRow(result.rows[0]) : null;
  }

  async listByPublisherEmail(
    publisherEmail: string,
  ): Promise<PublicationMetadata[]> {
    const result = await this.sql.query<PublicationRow>(
      "select * from publications where publisher_email = $1 order by updated_at desc",
      [publisherEmail],
    );
    return result.rows.map(mapPublicationRow);
  }
}

export function createNeonPublicationMetadataStore(
  databaseUrl = requiredEnv("DATABASE_URL"),
): PostgresPublicationMetadataStore {
  const sql = neon(databaseUrl);
  return new PostgresPublicationMetadataStore({
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) {
      const rows = (await sql.query(text, params)) as T[];
      return { rows };
    },
  });
}

export function publicationUrlPathFor(opaqueId: string): string {
  return `/a/${opaqueId}`;
}

interface PublicationRow {
  opaque_id: string;
  publication_url_path: string;
  publisher_email: string;
  status: PublicationStatus;
  active_manifest_ref: string;
  active_artifact_locator: string;
  local_source_path: string | null;
  revision_window_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  removed_at: Date | string | null;
}

function mapPublicationRow(
  row: PublicationRow | undefined,
): PublicationMetadata {
  if (!row) throw new Error("Expected Publication row");
  return {
    opaqueId: row.opaque_id,
    publicationUrlPath: row.publication_url_path,
    publisherEmail: row.publisher_email,
    status: row.status,
    activeManifestRef: row.active_manifest_ref,
    activeArtifactLocator: row.active_artifact_locator,
    localSourcePath: row.local_source_path,
    revisionWindowExpiresAt: row.revision_window_expires_at
      ? new Date(row.revision_window_expires_at)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    removedAt: row.removed_at ? new Date(row.removed_at) : null,
  };
}

function clonePublication(row: PublicationMetadata): PublicationMetadata {
  return {
    ...row,
    revisionWindowExpiresAt: row.revisionWindowExpiresAt
      ? new Date(row.revisionWindowExpiresAt)
      : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    removedAt: row.removedAt ? new Date(row.removedAt) : null,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
