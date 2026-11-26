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
  title: string | null;
  pwa: boolean;
  /** Stored password hash. Never send it to a client. Null = no password. */
  passwordHash: string | null;
  /** How long a password unlock lasts. Null = until the password changes. */
  unlockTtlMs: number | null;
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
  title?: string | null;
  pwa?: boolean;
  passwordHash?: string | null;
  unlockTtlMs?: number | null;
}

export interface UpdatePublicationInput {
  activeManifestRef?: string;
  activeArtifactLocator?: string;
  localSourcePath?: string | null;
  revisionWindowExpiresAt?: Date | null;
  title?: string | null;
  pwa?: boolean;
  passwordHash?: string | null;
  unlockTtlMs?: number | null;
}

export interface PublicationMetadataStore {
  create(input: CreatePublicationInput): Promise<PublicationMetadata>;
  getByOpaqueId(
    opaqueId: string,
    options?: { ignoreCase?: boolean },
  ): Promise<PublicationMetadata | null>;
  update(
    opaqueId: string,
    input: UpdatePublicationInput,
  ): Promise<PublicationMetadata | null>;
  markRemoved(opaqueId: string): Promise<PublicationMetadata | null>;
  listByPublisherEmail(publisherEmail: string): Promise<PublicationMetadata[]>;
  /** Password attempts for `limitKey` at or after `since`. */
  countUnlockAttempts(limitKey: string, since: Date): Promise<number>;
  recordUnlockAttempt(limitKey: string): Promise<void>;
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
  private readonly unlockAttempts: { limitKey: string; attemptedAt: Date }[] =
    [];
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
      title: input.title ?? null,
      pwa: input.pwa ?? false,
      passwordHash: input.passwordHash ?? null,
      unlockTtlMs: input.unlockTtlMs ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      removedAt: null,
    };
    this.rows.set(row.opaqueId, row);
    return clonePublication(row);
  }

  async getByOpaqueId(
    opaqueId: string,
    options?: { ignoreCase?: boolean },
  ): Promise<PublicationMetadata | null> {
    if (options?.ignoreCase) {
      const needle = opaqueId.toLowerCase();
      for (const row of this.rows.values()) {
        if (row.opaqueId.toLowerCase() === needle) return clonePublication(row);
      }
      return null;
    }
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
      title: Object.hasOwn(input, "title") ? (input.title ?? null) : row.title,
      pwa: Object.hasOwn(input, "pwa") ? Boolean(input.pwa) : row.pwa,
      passwordHash: Object.hasOwn(input, "passwordHash")
        ? (input.passwordHash ?? null)
        : row.passwordHash,
      unlockTtlMs: Object.hasOwn(input, "unlockTtlMs")
        ? (input.unlockTtlMs ?? null)
        : row.unlockTtlMs,
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

  async countUnlockAttempts(limitKey: string, since: Date): Promise<number> {
    return this.unlockAttempts.filter(
      (failure) =>
        failure.limitKey === limitKey &&
        failure.attemptedAt.getTime() >= since.getTime(),
    ).length;
  }

  async recordUnlockAttempt(limitKey: string): Promise<void> {
    this.unlockAttempts.push({ limitKey, attemptedAt: this.now() });
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
          title,
          pwa,
          password_hash,
          unlock_ttl_ms,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        input.title ?? null,
        input.pwa ?? false,
        input.passwordHash ?? null,
        input.unlockTtlMs ?? null,
        timestamp,
        timestamp,
      ],
    );
    return mapPublicationRow(result.rows[0]);
  }

  async getByOpaqueId(
    opaqueId: string,
    options?: { ignoreCase?: boolean },
  ): Promise<PublicationMetadata | null> {
    const result = await this.sql.query<PublicationRow>(
      options?.ignoreCase
        ? "select * from publications where lower(opaque_id) = lower($1) limit 1"
        : "select * from publications where opaque_id = $1",
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
            title = $6,
            pwa = $7,
            updated_at = $8,
            password_hash = $9,
            unlock_ttl_ms = $10
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
        Object.hasOwn(input, "title") ? (input.title ?? null) : existing.title,
        Object.hasOwn(input, "pwa") ? Boolean(input.pwa) : existing.pwa,
        this.now(),
        Object.hasOwn(input, "passwordHash")
          ? (input.passwordHash ?? null)
          : existing.passwordHash,
        Object.hasOwn(input, "unlockTtlMs")
          ? (input.unlockTtlMs ?? null)
          : existing.unlockTtlMs,
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

  async countUnlockAttempts(limitKey: string, since: Date): Promise<number> {
    const result = await this.sql.query<{ count: number | string }>(
      "select count(*) as count from publication_unlock_attempts where limit_key = $1 and attempted_at >= $2",
      [limitKey, since],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordUnlockAttempt(limitKey: string): Promise<void> {
    const timestamp = this.now();
    // Rows older than an hour are past every window; drop this key's.
    await this.sql.query(
      "delete from publication_unlock_attempts where limit_key = $1 and attempted_at < $2",
      [limitKey, new Date(timestamp.getTime() - 3_600_000)],
    );
    await this.sql.query(
      "insert into publication_unlock_attempts (limit_key, attempted_at) values ($1, $2)",
      [limitKey, timestamp],
    );
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
  title: string | null;
  pwa: boolean;
  password_hash?: string | null;
  unlock_ttl_ms?: number | string | null;
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
    title: row.title ?? null,
    pwa: Boolean(row.pwa),
    passwordHash: row.password_hash ?? null,
    unlockTtlMs:
      row.unlock_ttl_ms === null || row.unlock_ttl_ms === undefined
        ? null
        : Number(row.unlock_ttl_ms),
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
