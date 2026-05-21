import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  VercelBlobArtifactContentStore,
  type BlobClient,
} from "../src/storage/artifact-content.js";
import {
  InMemoryPublicationMetadataStore,
  PostgresPublicationMetadataStore,
  type SqlClient,
} from "../src/storage/publication-metadata.js";

const basePublication = {
  opaqueId: "Ab3xY9kQ",
  publisherEmail: "publisher@thefocus.ai",
  status: "active" as const,
  activeManifestRef: "manifest-1",
  localSourcePath: "/Users/example/report",
  revisionWindowExpiresAt: new Date("2026-05-20T12:15:00.000Z"),
};

describe("Publication metadata storage", () => {
  it("creates, reads, updates, lists, and marks Publications removed through the storage interface", async () => {
    const store = new InMemoryPublicationMetadataStore({
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });

    const created = await store.create(basePublication);
    expect(created).toMatchObject({
      opaqueId: "Ab3xY9kQ",
      publisherEmail: "publisher@thefocus.ai",
      status: "active",
      activeManifestRef: "manifest-1",
      localSourcePath: "/Users/example/report",
    });
    expect(created.publicationUrlPath).toBe("/a/Ab3xY9kQ");
    expect(created.updatedAt.toISOString()).toBe("2026-05-20T12:00:00.000Z");

    const updated = await store.update("Ab3xY9kQ", {
      activeManifestRef: "manifest-2",
      revisionWindowExpiresAt: new Date("2026-05-20T12:30:00.000Z"),
    });
    expect(updated?.activeManifestRef).toBe("manifest-2");
    expect(updated?.revisionWindowExpiresAt?.toISOString()).toBe(
      "2026-05-20T12:30:00.000Z",
    );

    const listed = await store.listByPublisherEmail("publisher@thefocus.ai");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.opaqueId).toBe("Ab3xY9kQ");

    const removed = await store.markRemoved("Ab3xY9kQ");
    expect(removed?.status).toBe("removed");
    expect(removed?.removedAt?.toISOString()).toBe("2026-05-20T12:00:00.000Z");
    expect((await store.getByOpaqueId("Ab3xY9kQ"))?.status).toBe("removed");
  });

  it("maps create/read/update/remove operations to Postgres-compatible SQL", async () => {
    const sql = new RecordingSqlClient();
    const store = new PostgresPublicationMetadataStore(sql, {
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });

    await store.create(basePublication);
    await store.getByOpaqueId("Ab3xY9kQ");
    await store.update("Ab3xY9kQ", { activeManifestRef: "manifest-2" });
    await store.markRemoved("Ab3xY9kQ");

    expect(sql.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("insert into publications"),
      expect.stringContaining(
        "select * from publications where opaque_id = $1",
      ),
      expect.stringContaining(
        "select * from publications where opaque_id = $1",
      ),
      expect.stringContaining("update publications"),
      expect.stringContaining("update publications"),
    ]);
    expect(sql.rows.get("Ab3xY9kQ")?.active_manifest_ref).toBe("manifest-2");
    expect(sql.rows.get("Ab3xY9kQ")?.status).toBe("removed");
  });
});

describe("Artifact content storage", () => {
  it("writes, reads, and deletes Artifact bytes through the local fake adapter", async () => {
    const store = new InMemoryArtifactContentStore();

    const written = await store.write({
      publicationId: "Ab3xY9kQ",
      manifestRef: "manifest-1",
      artifactPath: "index.html",
      body: Buffer.from("<h1>Hello</h1>"),
      contentType: "text/html; charset=utf-8",
    });

    expect(written.blobPath).toBe("artifacts/Ab3xY9kQ/manifest-1/index.html");
    await expect(store.read(written.blobPath)).resolves.toMatchObject({
      body: Buffer.from("<h1>Hello</h1>"),
      contentType: "text/html; charset=utf-8",
    });

    await store.delete([written.blobPath]);
    await expect(store.read(written.blobPath)).resolves.toBeNull();
  });

  it("uses the Vercel Blob-shaped put/fetch/delete contract", async () => {
    const blob = new RecordingBlobClient();
    const store = new VercelBlobArtifactContentStore(blob);

    const written = await store.write({
      publicationId: "Ab3xY9kQ",
      manifestRef: "manifest-1",
      artifactPath: "/assets/app.js",
      body: "console.log('ok');",
      contentType: "text/javascript",
    });

    expect(written).toEqual({
      blobPath: "artifacts/Ab3xY9kQ/manifest-1/assets/app.js",
      url: "blob://artifacts/Ab3xY9kQ/manifest-1/assets/app.js",
    });
    expect(blob.puts[0]).toMatchObject({
      path: "artifacts/Ab3xY9kQ/manifest-1/assets/app.js",
      options: {
        access: "public",
        contentType: "text/javascript",
        addRandomSuffix: false,
      },
    });

    const read = await store.read(written.blobPath);
    expect(read?.body.toString()).toBe("console.log('ok');");

    await store.delete([written.blobPath]);
    expect(blob.deleted).toEqual([
      "blob://artifacts/Ab3xY9kQ/manifest-1/assets/app.js",
    ]);
  });
});

class RecordingSqlClient implements SqlClient {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  readonly rows = new Map<string, Record<string, unknown>>();

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
    this.statements.push({ sql: normalized, params });

    if (normalized.startsWith("insert into publications")) {
      const row = {
        opaque_id: params[0],
        publication_url_path: params[1],
        publisher_email: params[2],
        status: params[3],
        active_manifest_ref: params[4],
        local_source_path: params[5],
        revision_window_expires_at: params[6],
        created_at: params[7],
        updated_at: params[8],
        removed_at: null,
      };
      this.rows.set(String(params[0]), row);
      return { rows: [row as T] };
    }

    if (normalized.startsWith("select * from publications where opaque_id")) {
      const row = this.rows.get(String(params[0]));
      return { rows: row ? [row as T] : [] };
    }

    if (
      normalized.startsWith("update publications") &&
      normalized.includes("status = 'removed'")
    ) {
      const row = this.rows.get(String(params[0]));
      if (!row) return { rows: [] };
      row.status = "removed";
      row.removed_at = params[1];
      row.updated_at = params[1];
      return { rows: [row as T] };
    }

    if (normalized.startsWith("update publications")) {
      const row = this.rows.get(String(params[0]));
      if (!row) return { rows: [] };
      row.active_manifest_ref = params[1];
      row.revision_window_expires_at = params[2];
      row.local_source_path = params[3];
      row.updated_at = params[4];
      return { rows: [row as T] };
    }

    return { rows: [] };
  }
}

class RecordingBlobClient implements BlobClient {
  readonly bodies = new Map<
    string,
    { body: Buffer; contentType: string | undefined; url: string }
  >();
  readonly puts: Array<{ path: string; body: unknown; options: unknown }> = [];
  readonly deleted: string[] = [];

  async put(
    path: string,
    body: unknown,
    options: Parameters<BlobClient["put"]>[2],
  ) {
    this.puts.push({ path, body, options });
    const buffer =
      typeof body === "string"
        ? Buffer.from(body)
        : Buffer.from(body as Uint8Array);
    const url = `blob://${path}`;
    this.bodies.set(path, {
      body: buffer,
      contentType: options.contentType,
      url,
    });
    return { url };
  }

  async fetch(url: string) {
    const path = url.replace(/^blob:\/\//, "");
    const item = this.bodies.get(path);
    if (!item) {
      return new Response(null, { status: 404 });
    }
    return new Response(new Uint8Array(item.body), {
      status: 200,
      headers: {
        "content-type": item.contentType ?? "application/octet-stream",
      },
    });
  }

  async del(urlOrPath: string | string[]) {
    const paths = Array.isArray(urlOrPath) ? urlOrPath : [urlOrPath];
    this.deleted.push(...paths);
    for (const path of paths) this.bodies.delete(path);
  }
}
