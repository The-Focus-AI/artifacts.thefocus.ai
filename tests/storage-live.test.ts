import { readFileSync } from "node:fs";
import { join } from "node:path";

import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

import { VercelBlobArtifactContentStore } from "../src/storage/artifact-content.js";
import { createNeonPublicationMetadataStore } from "../src/storage/publication-metadata.js";

const databaseUrl = process.env.DATABASE_URL;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

const describeWithDatabase = databaseUrl ? describe : describe.skip;
const describeWithBlob = blobToken ? describe : describe.skip;

describeWithDatabase("live Neon/Postgres Publication metadata storage", () => {
  it("creates, reads, updates, lists, and marks a Publication removed in Postgres", async () => {
    const sql = neon(databaseUrl!);
    await applyMigration(sql);

    const store = createNeonPublicationMetadataStore(databaseUrl!);
    const opaqueId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      const created = await store.create({
        opaqueId,
        publisherEmail: "storage-test@thefocus.ai",
        activeManifestRef: "manifest-live-1",
        localSourcePath: "/tmp/thefocus-artifacts-live-test",
        revisionWindowExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      expect(created.opaqueId).toBe(opaqueId);
      expect(created.publicationUrlPath).toBe(`/a/${opaqueId}`);

      const read = await store.getByOpaqueId(opaqueId);
      expect(read?.publisherEmail).toBe("storage-test@thefocus.ai");
      expect(read?.status).toBe("active");

      const updated = await store.update(opaqueId, {
        activeManifestRef: "manifest-live-2",
        revisionWindowExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      expect(updated?.activeManifestRef).toBe("manifest-live-2");
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt.getTime(),
      );

      const listed = await store.listByPublisherEmail(
        "storage-test@thefocus.ai",
      );
      expect(
        listed.some((publication) => publication.opaqueId === opaqueId),
      ).toBe(true);

      const removed = await store.markRemoved(opaqueId);
      expect(removed?.status).toBe("removed");
      expect(removed?.removedAt).toBeInstanceOf(Date);
    } finally {
      await sql.query("delete from publications where opaque_id = $1", [
        opaqueId,
      ]);
    }
  });
});

describeWithBlob("live Vercel Blob Artifact content storage", () => {
  it("writes, reads, and deletes Artifact bytes in Vercel Blob", async () => {
    const store = new VercelBlobArtifactContentStore();
    const publicationId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const written = await store.write({
      publicationId,
      manifestRef: "manifest-live-1",
      artifactPath: "index.html",
      body: "<h1>Live Vercel Blob storage test</h1>",
      contentType: "text/html; charset=utf-8",
    });

    try {
      const readByPath = await store.read(written.blobPath);
      expect(readByPath?.body.toString()).toBe(
        "<h1>Live Vercel Blob storage test</h1>",
      );
      expect(readByPath?.contentType).toContain("text/html");

      const readByUrl = await store.read(written.url);
      expect(readByUrl?.body.toString()).toBe(
        "<h1>Live Vercel Blob storage test</h1>",
      );
    } finally {
      await store.delete([written.url]);
    }

    await expect(store.read(written.url)).resolves.toBeNull();
  });
});

interface MigrationSqlClient {
  query(statement: string): Promise<unknown>;
}

async function applyMigration(sql: MigrationSqlClient) {
  const migration = readFileSync(
    join(process.cwd(), "migrations/0001_publications.sql"),
    "utf8",
  );
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.query(statement);
  }
}
