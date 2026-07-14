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
- `title` (human-readable title, derived from `<title>` or supplied with `--title`)
- created, updated, and removed timestamps

Apply `migrations/0005_create_living_docs.sql` for the Living Doc collaboration
feature (see `docs/adr/0005-living-docs-agent-human-review-loop.md`). It adds:

- `living_docs` — the Living Doc itself: `opaque_id` (View Link), `review_id`
  (Review Link capability), Publisher email, status, title, `current_markdown`,
  and `latest_version_number`.
- `living_doc_versions` — immutable Markdown snapshots cut each time the agent
  pulls feedback.
- `living_doc_comments` — Reviewer notes (and agent replies) anchored to a span.
- `living_doc_suggestions` — agent-proposed span changes with `pending` /
  `accepted` / `rejected` status.

## Review editor bundle

The Living Doc review page (`public/review.html`) and the read-only view page
are self-contained: the view page renders Markdown server-side, and the editor
loads CodeMirror and markdown-it from the committed bundle
`public/vendor/review-editor.js` — no CDN at runtime. After upgrading those
dependencies, regenerate and commit the bundle:

```bash
pnpm run build:review-editor
```

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
