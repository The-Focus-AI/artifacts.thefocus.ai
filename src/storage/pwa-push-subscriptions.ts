import { randomBytes } from "node:crypto";

import { neon } from "@neondatabase/serverless";

import type { ClockOptions, SqlClient } from "./publication-metadata.js";

export interface PwaPushSubscriptionRecord {
  id: string;
  opaqueId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface UpsertPwaPushSubscriptionInput {
  opaqueId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export interface PwaPushSubscriptionStore {
  upsert(
    input: UpsertPwaPushSubscriptionInput,
  ): Promise<PwaPushSubscriptionRecord>;
  deleteByEndpoint(input: {
    opaqueId: string;
    endpoint: string;
  }): Promise<boolean>;
  listByOpaqueId(opaqueId: string): Promise<PwaPushSubscriptionRecord[]>;
  deleteById(id: string): Promise<void>;
}

export class InMemoryPwaPushSubscriptionStore implements PwaPushSubscriptionStore {
  private readonly rows = new Map<string, PwaPushSubscriptionRecord>();
  private readonly now: () => Date;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async upsert(
    input: UpsertPwaPushSubscriptionInput,
  ): Promise<PwaPushSubscriptionRecord> {
    const existing = [...this.rows.values()].find(
      (row) => row.endpoint === input.endpoint,
    );
    const timestamp = this.now();
    const row: PwaPushSubscriptionRecord = {
      id: existing?.id ?? createPushSubscriptionId(),
      opaqueId: input.opaqueId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      lastSeenAt: timestamp,
    };
    this.rows.set(row.id, row);
    return clonePwaPushSubscription(row);
  }

  async deleteByEndpoint(input: {
    opaqueId: string;
    endpoint: string;
  }): Promise<boolean> {
    for (const [id, row] of this.rows) {
      if (row.endpoint === input.endpoint && row.opaqueId === input.opaqueId) {
        this.rows.delete(id);
        return true;
      }
    }
    return false;
  }

  async listByOpaqueId(opaqueId: string): Promise<PwaPushSubscriptionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.opaqueId === opaqueId)
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .map(clonePwaPushSubscription);
  }

  async deleteById(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class PostgresPwaPushSubscriptionStore implements PwaPushSubscriptionStore {
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: ClockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async upsert(
    input: UpsertPwaPushSubscriptionInput,
  ): Promise<PwaPushSubscriptionRecord> {
    const timestamp = this.now();
    const result = await this.sql.query<PwaPushSubscriptionRow>(
      `
        insert into pwa_push_subscriptions (
          id, opaque_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $7)
        on conflict (endpoint) do update set
          opaque_id = excluded.opaque_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          last_seen_at = excluded.last_seen_at
        returning *
      `,
      [
        createPushSubscriptionId(),
        input.opaqueId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.userAgent ?? null,
        timestamp,
      ],
    );
    return mapPwaPushSubscriptionRow(result.rows[0]);
  }

  async deleteByEndpoint(input: {
    opaqueId: string;
    endpoint: string;
  }): Promise<boolean> {
    const result = await this.sql.query<{ id: string }>(
      `
        delete from pwa_push_subscriptions
        where opaque_id = $1 and endpoint = $2
        returning id
      `,
      [input.opaqueId, input.endpoint],
    );
    return result.rows.length > 0;
  }

  async listByOpaqueId(opaqueId: string): Promise<PwaPushSubscriptionRecord[]> {
    const result = await this.sql.query<PwaPushSubscriptionRow>(
      `
        select * from pwa_push_subscriptions
        where opaque_id = $1
        order by created_at asc
      `,
      [opaqueId],
    );
    return result.rows.map(mapPwaPushSubscriptionRow);
  }

  async deleteById(id: string): Promise<void> {
    await this.sql.query("delete from pwa_push_subscriptions where id = $1", [
      id,
    ]);
  }
}

export function createNeonPwaPushSubscriptionStore(
  databaseUrl = requiredEnv("DATABASE_URL"),
): PostgresPwaPushSubscriptionStore {
  const sql = neon(databaseUrl);
  return new PostgresPwaPushSubscriptionStore({
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) {
      const rows = (await sql.query(text, params)) as T[];
      return { rows };
    },
  });
}

export function createPushSubscriptionId(): string {
  return randomBytes(16).toString("base64url");
}

interface PwaPushSubscriptionRow {
  id: string;
  opaque_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

function mapPwaPushSubscriptionRow(
  row: PwaPushSubscriptionRow | undefined,
): PwaPushSubscriptionRecord {
  if (!row) throw new Error("Expected PWA push subscription row");
  return {
    id: row.id,
    opaqueId: row.opaque_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

function clonePwaPushSubscription(
  row: PwaPushSubscriptionRecord,
): PwaPushSubscriptionRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    lastSeenAt: new Date(row.lastSeenAt),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
