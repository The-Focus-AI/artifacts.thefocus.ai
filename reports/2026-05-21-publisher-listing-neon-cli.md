---
title: "Publisher Publication Listing: Neon Serverless + TypeScript CLI Notes"
date: 2026-05-21
topic: publisher-publication-listing
project_context:
  language: TypeScript
  runtime: Node.js CLI and Vercel serverless functions
  relevant_dependencies:
    - "@neondatabase/serverless: ^1.1.0"
    - "vitest: ^4.1.7"
---

## Summary

For the `artifacts list` slice, keep the implementation aligned with the existing project architecture:

- Authenticate every CLI list request with the active Publisher Token.
- Resolve the Publisher email through the existing token store/authentication path.
- Query Publication metadata by the authenticated Publisher email only.
- Return active and removed Publications in one unpaginated v1 response.
- Format CLI output as a simple human-readable table containing last updated time, status, title, and full Publication URL.

## Neon serverless notes

The Neon serverless driver supports one-shot parameterized SQL through the `neon(...)` tagged-template query function. The tagged template safely parameterizes interpolated values and returns rows as arrays of objects by default. Use this for simple read paths such as listing Publications by Publisher email.

Relevant patterns:

```ts
const rows = await sql`
  select opaque_id, publisher_email, status, updated_at
  from publications
  where publisher_email = ${email}
  order by updated_at desc
`;
```

Use `sql.query('... where email = $1', [email])` only when a query string must be assembled outside a template literal. Avoid `unsafe()` unless interpolating trusted identifiers, which this feature does not need.

Transactions are unnecessary for a single list query. If future list behavior needs multiple consistent reads, Neon exposes `sql.transaction([...])` for non-interactive transactions.

## CLI and testing notes

The existing CLI tests invoke `main(argv, deps)` with injected dependencies and capture output through custom stdout/stderr writers. Preserve that pattern rather than shelling out to the built CLI.

Test the new list feature at two seams:

1. Storage/API seam: list by Publisher email returns only that email's rows and includes both active and removed statuses.
2. CLI seam: unauthenticated list fails; authenticated list calls the API client with the Publisher Token and prints rows with `updated_at`, status, title, and full Publication URL.

## Pitfalls to avoid

- Do not list team-wide Publications; v1 list is scoped to the authenticated Publisher email.
- Do not omit removed Publications; they are part of the audit trail.
- Do not add pagination/filtering yet; v1 returns all matching rows.
- Do not expose raw internal blob locators or manifest details in list output.
- Keep status language compatible with existing Removal terminology (`active`, `removed`).

## Sources consulted

- Neon serverless driver README and docs via code search: `neon(...)` tagged template, safe parameter interpolation, default rows-as-objects result, `sql.query()` for manually parameterized SQL, and `sql.transaction()` for non-interactive transactions.
- Existing repository tests: `tests/cli-auth.test.ts`, `tests/storage-foundation.test.ts`, and `tests/revision-window.test.ts` for dependency injection and fake storage conventions.
