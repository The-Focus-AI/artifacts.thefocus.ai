import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { neon } from "@neondatabase/serverless";

import type {
  ClockOptions,
  SqlClient,
} from "./storage/publication-metadata.js";

/**
 * `cli` tokens are minted by the browser login flow and live in the
 * Publisher's own config directory. `mcp` tokens are minted explicitly and are
 * expected to be pasted into third-party MCP client configuration, so they are
 * separated to be independently revocable.
 */
export type PublisherTokenKind = "cli" | "mcp";

export const publisherTokenKinds: readonly PublisherTokenKind[] = [
  "cli",
  "mcp",
];

/**
 * How long a Publisher Token's last-used timestamp is allowed to go stale
 * before another write. MCP is chatty — an `initialize`, a `tools/list`, and a
 * write per `tools/call` — and last-used is diagnostic, not a security control.
 */
const lastUsedWriteIntervalMs = 60 * 60 * 1000;

export interface PublisherTokenRecord {
  tokenHash: string;
  /** Public handle for revocation: a prefix of the hash, never the token. */
  tokenId: string;
  publisherEmail: string;
  kind: PublisherTokenKind;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface PublisherTokenStore {
  create(input: {
    tokenHash: string;
    publisherEmail: string;
    createdAt: Date;
    kind?: PublisherTokenKind;
    label?: string | null;
  }): Promise<PublisherTokenRecord>;
  getByTokenHash(tokenHash: string): Promise<PublisherTokenRecord | null>;
  markUsed(tokenHash: string, usedAt: Date): Promise<void>;
  listByPublisherEmail(publisherEmail: string): Promise<PublisherTokenRecord[]>;
  markRevoked(tokenHash: string, revokedAt: Date): Promise<void>;
}

export interface IssuePublisherTokenResult {
  token: string;
  tokenHash: string;
  tokenId: string;
  publisherEmail: string;
  kind: PublisherTokenKind;
  label: string | null;
}

export class InvalidPublisherEmailError extends Error {
  constructor(email: string) {
    super(
      `Publishing is limited to verified email addresses ending exactly in @thefocus.ai: ${email}`,
    );
    this.name = "InvalidPublisherEmailError";
  }
}

export class InvalidPublisherTokenError extends Error {
  constructor() {
    super("A valid Publisher Token is required");
    this.name = "InvalidPublisherTokenError";
  }
}

export class RevokedPublisherTokenError extends Error {
  constructor(tokenId: string) {
    super(
      `This Publisher Token was revoked (${tokenId}). Create a new one with: artifacts token create`,
    );
    this.name = "RevokedPublisherTokenError";
  }
}

export class InMemoryPublisherTokenStore implements PublisherTokenStore {
  private readonly rows = new Map<string, PublisherTokenRecord>();
  private readonly now: () => Date;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: {
    tokenHash: string;
    publisherEmail: string;
    createdAt?: Date;
    kind?: PublisherTokenKind;
    label?: string | null;
  }): Promise<PublisherTokenRecord> {
    const row: PublisherTokenRecord = {
      tokenHash: input.tokenHash,
      tokenId: publisherTokenIdFromHash(input.tokenHash),
      publisherEmail: input.publisherEmail,
      kind: input.kind ?? "cli",
      label: input.label ?? null,
      createdAt: input.createdAt ?? this.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.rows.set(row.tokenHash, row);
    return clonePublisherTokenRecord(row);
  }

  async getByTokenHash(
    tokenHash: string,
  ): Promise<PublisherTokenRecord | null> {
    const row = this.rows.get(tokenHash);
    return row ? clonePublisherTokenRecord(row) : null;
  }

  async markUsed(tokenHash: string, usedAt: Date): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (!row) return;
    this.rows.set(tokenHash, { ...row, lastUsedAt: usedAt });
  }

  async listByPublisherEmail(
    publisherEmail: string,
  ): Promise<PublisherTokenRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.publisherEmail === publisherEmail)
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      )
      .map(clonePublisherTokenRecord);
  }

  async markRevoked(tokenHash: string, revokedAt: Date): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (!row) return;
    this.rows.set(tokenHash, { ...row, revokedAt });
  }
}

export class PostgresPublisherTokenStore implements PublisherTokenStore {
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: ClockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: {
    tokenHash: string;
    publisherEmail: string;
    createdAt?: Date;
    kind?: PublisherTokenKind;
    label?: string | null;
  }): Promise<PublisherTokenRecord> {
    const createdAt = input.createdAt ?? this.now();
    const result = await this.sql.query<PublisherTokenRow>(
      `
        insert into publisher_tokens (token_hash, publisher_email, created_at, kind, label)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [
        input.tokenHash,
        input.publisherEmail,
        createdAt,
        input.kind ?? "cli",
        input.label ?? null,
      ],
    );
    return mapPublisherTokenRow(result.rows[0]);
  }

  async getByTokenHash(
    tokenHash: string,
  ): Promise<PublisherTokenRecord | null> {
    const result = await this.sql.query<PublisherTokenRow>(
      "select * from publisher_tokens where token_hash = $1",
      [tokenHash],
    );
    return result.rows[0] ? mapPublisherTokenRow(result.rows[0]) : null;
  }

  async markUsed(tokenHash: string, usedAt: Date): Promise<void> {
    await this.sql.query(
      "update publisher_tokens set last_used_at = $2 where token_hash = $1",
      [tokenHash, usedAt],
    );
  }

  async listByPublisherEmail(
    publisherEmail: string,
  ): Promise<PublisherTokenRecord[]> {
    const result = await this.sql.query<PublisherTokenRow>(
      "select * from publisher_tokens where publisher_email = $1 order by created_at desc",
      [publisherEmail],
    );
    return result.rows.map((row) => mapPublisherTokenRow(row));
  }

  async markRevoked(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.sql.query(
      "update publisher_tokens set revoked_at = $2 where token_hash = $1 and revoked_at is null",
      [tokenHash, revokedAt],
    );
  }
}

export async function issuePublisherToken(input: {
  email: string;
  store: PublisherTokenStore;
  now?: () => Date;
  tokenFactory?: () => string;
  kind?: PublisherTokenKind;
  label?: string | null;
}): Promise<IssuePublisherTokenResult> {
  const publisherEmail = normalizePublisherEmail(input.email);
  const kind = input.kind ?? "cli";
  const token = input.tokenFactory?.() ?? createPublisherToken(kind);
  const tokenHash = hashPublisherToken(token);
  await input.store.create({
    tokenHash,
    publisherEmail,
    createdAt: input.now?.() ?? new Date(),
    kind,
    label: input.label ?? null,
  });
  return {
    token,
    tokenHash,
    tokenId: publisherTokenIdFromHash(tokenHash),
    publisherEmail,
    kind,
    label: input.label ?? null,
  };
}

export interface AuthenticatePublisherTokenInput {
  token: string | null | undefined;
  store: PublisherTokenStore;
  now?: () => Date;
}

/**
 * Validate a Publisher Token and return the whole record. Callers that only
 * need the identity should use `authenticatePublisherToken`; the MCP surface
 * uses this so it can report which kind of token is in play.
 */
export async function authenticatePublisherTokenRecord(
  input: AuthenticatePublisherTokenInput,
): Promise<PublisherTokenRecord> {
  if (!input.token) throw new InvalidPublisherTokenError();
  const tokenHash = hashPublisherToken(input.token);
  const record = await input.store.getByTokenHash(tokenHash);
  if (!record || !constantTimeEqual(record.tokenHash, tokenHash)) {
    throw new InvalidPublisherTokenError();
  }
  if (record.revokedAt) {
    throw new RevokedPublisherTokenError(record.tokenId);
  }
  const now = input.now?.() ?? new Date();
  if (shouldRecordTokenUse(record, now)) {
    await input.store.markUsed(tokenHash, now);
  }
  return record;
}

export async function authenticatePublisherToken(
  input: AuthenticatePublisherTokenInput,
): Promise<string> {
  const record = await authenticatePublisherTokenRecord(input);
  return record.publisherEmail;
}

export async function listPublisherTokens(input: {
  publisherEmail: string;
  store: PublisherTokenStore;
}): Promise<PublisherTokenRecord[]> {
  return input.store.listByPublisherEmail(input.publisherEmail);
}

export interface RevokePublisherTokenResult {
  tokenId: string;
  status: "revoked" | "already-revoked" | "not-found";
}

/**
 * Revoke by Token Id — the hash prefix shown in `artifacts token list`. The
 * raw token is shown once at creation and is never recoverable, so the Token
 * Id is the only handle a Publisher has after the fact.
 */
export async function revokePublisherToken(input: {
  tokenId: string;
  publisherEmail: string;
  store: PublisherTokenStore;
  now?: () => Date;
}): Promise<RevokePublisherTokenResult> {
  const tokenId = input.tokenId.trim().toLowerCase();
  const records = await input.store.listByPublisherEmail(input.publisherEmail);
  const record = records.find((candidate) => candidate.tokenId === tokenId);
  if (!record) return { tokenId, status: "not-found" };
  if (record.revokedAt) return { tokenId, status: "already-revoked" };
  await input.store.markRevoked(record.tokenHash, input.now?.() ?? new Date());
  return { tokenId, status: "revoked" };
}

function shouldRecordTokenUse(
  record: PublisherTokenRecord,
  now: Date,
): boolean {
  if (!record.lastUsedAt) return true;
  return now.getTime() - record.lastUsedAt.getTime() >= lastUsedWriteIntervalMs;
}

export function normalizePublisherEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!isTheFocusPublisherEmail(normalized)) {
    throw new InvalidPublisherEmailError(email);
  }
  return normalized;
}

export function isTheFocusPublisherEmail(email: string): boolean {
  return /^[^@\s]+@thefocus\.ai$/.test(email.trim().toLowerCase());
}

export function createPublisherToken(kind: PublisherTokenKind = "cli"): string {
  const prefix = kind === "mcp" ? "tfai_mcp_" : "tfai_pub_";
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function hashPublisherToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The public handle for a Publisher Token. A prefix of the SHA-256 hash: safe
 * to print and to store in logs, useless for authenticating.
 */
export function publisherTokenIdFromHash(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

export function createNeonPublisherTokenStore(
  databaseUrl = requiredEnv("DATABASE_URL"),
): PostgresPublisherTokenStore {
  const sql = neon(databaseUrl);
  return new PostgresPublisherTokenStore({
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) {
      const rows = (await sql.query(text, params)) as T[];
      return { rows };
    },
  });
}

interface PublisherTokenRow {
  token_hash: string;
  publisher_email: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  kind?: string | null;
  label?: string | null;
  revoked_at?: Date | string | null;
}

function mapPublisherTokenRow(
  row: PublisherTokenRow | undefined,
): PublisherTokenRecord {
  if (!row) throw new Error("Expected Publisher Token row");
  return {
    tokenHash: row.token_hash,
    tokenId: publisherTokenIdFromHash(row.token_hash),
    publisherEmail: row.publisher_email,
    kind: row.kind === "mcp" ? "mcp" : "cli",
    label: row.label ?? null,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function clonePublisherTokenRecord(
  row: PublisherTokenRecord,
): PublisherTokenRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
