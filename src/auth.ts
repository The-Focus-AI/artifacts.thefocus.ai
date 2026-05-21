import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { neon } from "@neondatabase/serverless";

import type {
  ClockOptions,
  SqlClient,
} from "./storage/publication-metadata.js";

export interface PublisherTokenRecord {
  tokenHash: string;
  publisherEmail: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PublisherTokenStore {
  create(input: {
    tokenHash: string;
    publisherEmail: string;
    createdAt: Date;
  }): Promise<PublisherTokenRecord>;
  getByTokenHash(tokenHash: string): Promise<PublisherTokenRecord | null>;
  markUsed(tokenHash: string, usedAt: Date): Promise<void>;
}

export interface IssuePublisherTokenResult {
  token: string;
  tokenHash: string;
  publisherEmail: string;
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
  }): Promise<PublisherTokenRecord> {
    const row: PublisherTokenRecord = {
      tokenHash: input.tokenHash,
      publisherEmail: input.publisherEmail,
      createdAt: input.createdAt ?? this.now(),
      lastUsedAt: null,
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
  }): Promise<PublisherTokenRecord> {
    const createdAt = input.createdAt ?? this.now();
    const result = await this.sql.query<PublisherTokenRow>(
      `
        insert into publisher_tokens (token_hash, publisher_email, created_at)
        values ($1, $2, $3)
        returning *
      `,
      [input.tokenHash, input.publisherEmail, createdAt],
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
}

export async function issuePublisherToken(input: {
  email: string;
  store: PublisherTokenStore;
  now?: () => Date;
  tokenFactory?: () => string;
}): Promise<IssuePublisherTokenResult> {
  const publisherEmail = normalizePublisherEmail(input.email);
  const token = input.tokenFactory?.() ?? createPublisherToken();
  const tokenHash = hashPublisherToken(token);
  await input.store.create({
    tokenHash,
    publisherEmail,
    createdAt: input.now?.() ?? new Date(),
  });
  return { token, tokenHash, publisherEmail };
}

export async function authenticatePublisherToken(input: {
  token: string | null | undefined;
  store: PublisherTokenStore;
  now?: () => Date;
}): Promise<string> {
  if (!input.token) throw new InvalidPublisherTokenError();
  const tokenHash = hashPublisherToken(input.token);
  const record = await input.store.getByTokenHash(tokenHash);
  if (!record || !constantTimeEqual(record.tokenHash, tokenHash)) {
    throw new InvalidPublisherTokenError();
  }
  await input.store.markUsed(tokenHash, input.now?.() ?? new Date());
  return record.publisherEmail;
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

export function createPublisherToken(): string {
  return `tfai_pub_${randomBytes(32).toString("base64url")}`;
}

export function hashPublisherToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
}

function mapPublisherTokenRow(row: PublisherTokenRow | undefined) {
  if (!row) throw new Error("Expected Publisher Token row");
  return {
    tokenHash: row.token_hash,
    publisherEmail: row.publisher_email,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  };
}

function clonePublisherTokenRecord(
  row: PublisherTokenRecord,
): PublisherTokenRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
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
