# Local development

## Environment contract

The production-shaped storage foundation expects these environment variables when real infrastructure is used:

- `DATABASE_URL` — Neon/Postgres connection string used by the Publication metadata store.
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token used by the Artifact content store.

Do not commit secret values. Put local bootstrap values in `.fnox/env` or the runtime environment.

## Metadata schema

Apply `migrations/0001_publications.sql` to the Neon/Postgres database before using the real metadata store. The schema stores:

- opaque Publication URL identity (`opaque_id`, `publication_url_path`)
- Publisher email
- Publication status (`active` or `removed`)
- active manifest reference
- Local Source path and Revision Window expiry fields
- created, updated, and removed timestamps

## Test and local adapters

Automated tests use in-memory/fake adapters, so they do not require Neon or Vercel Blob credentials. Later application code can import:

- `InMemoryPublicationMetadataStore` and `InMemoryArtifactContentStore` for local tests.
- `createNeonPublicationMetadataStore` for Neon/Postgres-backed metadata.
- `VercelBlobArtifactContentStore` for Vercel Blob-backed Artifact bytes.

## Verification commands

Use mise so the repo-local toolchain is used:

```bash
mise run lint
mise run test
mise run dev
```
