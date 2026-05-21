# Local development

## Environment contract

The production-shaped storage foundation expects these environment variables when real infrastructure is used:

- `DATABASE_URL` — Neon/Postgres connection string used by the Publication metadata store.
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token used by the Artifact content store.

Do not commit secret values. Runtime secrets live in the dedicated 1Password vault `Artifacts` and are resolved by fnox. The only value that belongs in local `.fnox/env` is the bootstrap `OP_SERVICE_ACCOUNT_TOKEN`, pulled from the `thefocus` vault by `mise run setup`.

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

## Live storage verification

Create or update those 1Password items with the 1Password CLI:

```bash
op item create --vault "Artifacts" --category=password --title=DATABASE_URL "password=<neon-postgres-url>"
op item create --vault "Artifacts" --category=password --title=BLOB_READ_WRITE_TOKEN "password=<vercel-blob-token>"
```

Then run live verification through fnox:

```bash
# First acceptance criterion: Neon/Postgres metadata only
fnox exec -- pnpm run test:storage:live:db

# Blob storage only
fnox exec -- pnpm run test:storage:live:blob

# Both live storage checks
fnox exec -- pnpm run test:storage:live
```

The database check applies `migrations/0001_publications.sql`, creates/reads/updates/lists/marks removed a temporary Publication row in Neon/Postgres, and then cleans up the row. The Blob check writes/reads/deletes a temporary Artifact object in Vercel Blob.

## Verification commands

Use mise so the repo-local toolchain is used:

```bash
mise run lint
mise run test
mise run dev
```
