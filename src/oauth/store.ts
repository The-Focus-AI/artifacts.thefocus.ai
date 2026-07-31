import { neon } from "@neondatabase/serverless";

import type {
  ClockOptions,
  SqlClient,
} from "../storage/publication-metadata.js";

export type OAuthTokenKind = "access" | "refresh";

export interface OAuthClientRecord {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: Date;
}

export interface OAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  publisherEmail: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface OAuthTokenRecord {
  tokenHash: string;
  kind: OAuthTokenKind;
  clientId: string;
  publisherEmail: string;
  scope: string | null;
  resource: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface OAuthStore {
  createClient(input: {
    clientId: string;
    clientName?: string | null;
    redirectUris: string[];
    createdAt?: Date;
  }): Promise<OAuthClientRecord>;
  getClient(clientId: string): Promise<OAuthClientRecord | null>;

  createAuthorizationCode(
    input: Omit<OAuthAuthorizationCodeRecord, "consumedAt">,
  ): Promise<void>;
  /**
   * Atomically mark a code consumed and return it. A code that was already
   * consumed returns null, so a replayed code cannot mint a second token.
   */
  consumeAuthorizationCode(
    codeHash: string,
    consumedAt: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null>;

  createToken(
    input: Omit<OAuthTokenRecord, "revokedAt" | "createdAt"> & {
      createdAt?: Date;
    },
  ): Promise<OAuthTokenRecord>;
  getToken(tokenHash: string): Promise<OAuthTokenRecord | null>;
  revokeToken(tokenHash: string, revokedAt: Date): Promise<void>;
  listTokensByPublisherEmail(
    publisherEmail: string,
  ): Promise<OAuthTokenRecord[]>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClientRecord>();
  private readonly codes = new Map<string, OAuthAuthorizationCodeRecord>();
  private readonly tokens = new Map<string, OAuthTokenRecord>();
  private readonly now: () => Date;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createClient(input: {
    clientId: string;
    clientName?: string | null;
    redirectUris: string[];
    createdAt?: Date;
  }): Promise<OAuthClientRecord> {
    const record: OAuthClientRecord = {
      clientId: input.clientId,
      clientName: input.clientName ?? null,
      redirectUris: [...input.redirectUris],
      createdAt: input.createdAt ?? this.now(),
    };
    this.clients.set(record.clientId, record);
    return { ...record, redirectUris: [...record.redirectUris] };
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const record = this.clients.get(clientId);
    return record
      ? { ...record, redirectUris: [...record.redirectUris] }
      : null;
  }

  async createAuthorizationCode(
    input: Omit<OAuthAuthorizationCodeRecord, "consumedAt">,
  ): Promise<void> {
    this.codes.set(input.codeHash, { ...input, consumedAt: null });
  }

  async consumeAuthorizationCode(
    codeHash: string,
    consumedAt: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null> {
    const record = this.codes.get(codeHash);
    if (!record || record.consumedAt) return null;
    const consumed = { ...record, consumedAt };
    this.codes.set(codeHash, consumed);
    return consumed;
  }

  async createToken(
    input: Omit<OAuthTokenRecord, "revokedAt" | "createdAt"> & {
      createdAt?: Date;
    },
  ): Promise<OAuthTokenRecord> {
    const record: OAuthTokenRecord = {
      ...input,
      revokedAt: null,
      createdAt: input.createdAt ?? this.now(),
    };
    this.tokens.set(record.tokenHash, record);
    return { ...record };
  }

  async getToken(tokenHash: string): Promise<OAuthTokenRecord | null> {
    const record = this.tokens.get(tokenHash);
    return record ? { ...record } : null;
  }

  async revokeToken(tokenHash: string, revokedAt: Date): Promise<void> {
    const record = this.tokens.get(tokenHash);
    if (!record || record.revokedAt) return;
    this.tokens.set(tokenHash, { ...record, revokedAt });
  }

  async listTokensByPublisherEmail(
    publisherEmail: string,
  ): Promise<OAuthTokenRecord[]> {
    return [...this.tokens.values()]
      .filter((record) => record.publisherEmail === publisherEmail)
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      )
      .map((record) => ({ ...record }));
  }
}

export class PostgresOAuthStore implements OAuthStore {
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: ClockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createClient(input: {
    clientId: string;
    clientName?: string | null;
    redirectUris: string[];
    createdAt?: Date;
  }): Promise<OAuthClientRecord> {
    const result = await this.sql.query<OAuthClientRow>(
      `
        insert into oauth_clients (client_id, client_name, redirect_uris, created_at)
        values ($1, $2, $3, $4)
        on conflict (client_id) do update
          set client_name = excluded.client_name,
              redirect_uris = excluded.redirect_uris
        returning *
      `,
      [
        input.clientId,
        input.clientName ?? null,
        JSON.stringify(input.redirectUris),
        input.createdAt ?? this.now(),
      ],
    );
    return mapClientRow(result.rows[0]);
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const result = await this.sql.query<OAuthClientRow>(
      "select * from oauth_clients where client_id = $1",
      [clientId],
    );
    return result.rows[0] ? mapClientRow(result.rows[0]) : null;
  }

  async createAuthorizationCode(
    input: Omit<OAuthAuthorizationCodeRecord, "consumedAt">,
  ): Promise<void> {
    await this.sql.query(
      `
        insert into oauth_authorization_codes
          (code_hash, client_id, publisher_email, redirect_uri, code_challenge,
           code_challenge_method, scope, resource, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.codeHash,
        input.clientId,
        input.publisherEmail,
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        input.scope,
        input.resource,
        input.expiresAt,
      ],
    );
  }

  async consumeAuthorizationCode(
    codeHash: string,
    consumedAt: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null> {
    // The `consumed_at is null` predicate makes replay a no-op rather than a
    // second token: whichever request updates the row first wins.
    const result = await this.sql.query<OAuthAuthorizationCodeRow>(
      `
        update oauth_authorization_codes
           set consumed_at = $2
         where code_hash = $1 and consumed_at is null
        returning *
      `,
      [codeHash, consumedAt],
    );
    return result.rows[0] ? mapCodeRow(result.rows[0]) : null;
  }

  async createToken(
    input: Omit<OAuthTokenRecord, "revokedAt" | "createdAt"> & {
      createdAt?: Date;
    },
  ): Promise<OAuthTokenRecord> {
    const result = await this.sql.query<OAuthTokenRow>(
      `
        insert into oauth_tokens
          (token_hash, kind, client_id, publisher_email, scope, resource, expires_at, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning *
      `,
      [
        input.tokenHash,
        input.kind,
        input.clientId,
        input.publisherEmail,
        input.scope,
        input.resource,
        input.expiresAt,
        input.createdAt ?? this.now(),
      ],
    );
    return mapTokenRow(result.rows[0]);
  }

  async getToken(tokenHash: string): Promise<OAuthTokenRecord | null> {
    const result = await this.sql.query<OAuthTokenRow>(
      "select * from oauth_tokens where token_hash = $1",
      [tokenHash],
    );
    return result.rows[0] ? mapTokenRow(result.rows[0]) : null;
  }

  async revokeToken(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.sql.query(
      "update oauth_tokens set revoked_at = $2 where token_hash = $1 and revoked_at is null",
      [tokenHash, revokedAt],
    );
  }

  async listTokensByPublisherEmail(
    publisherEmail: string,
  ): Promise<OAuthTokenRecord[]> {
    const result = await this.sql.query<OAuthTokenRow>(
      "select * from oauth_tokens where publisher_email = $1 order by created_at desc",
      [publisherEmail],
    );
    return result.rows.map((row) => mapTokenRow(row));
  }
}

export function createNeonOAuthStore(
  databaseUrl = requiredEnv("DATABASE_URL"),
): PostgresOAuthStore {
  const sql = neon(databaseUrl);
  return new PostgresOAuthStore({
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) {
      const rows = (await sql.query(text, params)) as T[];
      return { rows };
    },
  });
}

interface OAuthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[] | string;
  created_at: Date | string;
}

interface OAuthAuthorizationCodeRow {
  code_hash: string;
  client_id: string;
  publisher_email: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

interface OAuthTokenRow {
  token_hash: string;
  kind: string;
  client_id: string;
  publisher_email: string;
  scope: string | null;
  resource: string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

function mapClientRow(row: OAuthClientRow | undefined): OAuthClientRecord {
  if (!row) throw new Error("Expected OAuth client row");
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris:
      typeof row.redirect_uris === "string"
        ? (JSON.parse(row.redirect_uris) as string[])
        : row.redirect_uris,
    createdAt: new Date(row.created_at),
  };
}

function mapCodeRow(
  row: OAuthAuthorizationCodeRow,
): OAuthAuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    publisherEmail: row.publisher_email,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    scope: row.scope,
    resource: row.resource,
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
  };
}

function mapTokenRow(row: OAuthTokenRow | undefined): OAuthTokenRecord {
  if (!row) throw new Error("Expected OAuth token row");
  return {
    tokenHash: row.token_hash,
    kind: row.kind === "refresh" ? "refresh" : "access",
    clientId: row.client_id,
    publisherEmail: row.publisher_email,
    scope: row.scope,
    resource: row.resource,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
