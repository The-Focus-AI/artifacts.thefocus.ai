---
title: "Removal Flow Implementation Notes: Vercel Blob + Node CLI Confirmation"
date: 2026-05-21
topic: removal-flow-vercel-blob-cli
project_context:
  language: TypeScript
  runtime: Node.js CLI and Vercel serverless functions
  relevant_dependencies:
    - "@vercel/blob@2.4.0"
    - "@neondatabase/serverless@1.1.0"
---

## Summary

Issue #8 needs Removal to be a destructive authenticated operation: mark Publication metadata as removed, delete current Artifact Blob contents, return 404 for removed Publications, and clear matching local CLI state. Existing project architecture already stores Publication status in Neon-shaped metadata and serves only `status === "active"`, so the correct slice is to add a testable Removal module function and wire it to the CLI.

## Findings

### Vercel Blob deletion

The Vercel Blob SDK exposes `del()` for deleting one or multiple blob URLs in a single call. The docs note that blobs are cached and deletion/update propagation can take up to about one minute at the Vercel CDN edge, so the service should not rely on Blob deletion alone for viewer behavior. Metadata status should gate serving immediately; Blob deletion is cleanup and exposure reduction.

Implication for this repo: first collect all active locators from the current manifest, mark the Publication removed, and then delete locators. Serving already checks `publication.status !== "active"` and returns 404 with no-store/noindex headers.

### Directory Artifact cleanup

Directory Artifacts store an active manifest plus per-file locators. Removal must delete the active manifest and all file locators referenced by it. This mirrors the update path, which already reads the active manifest to delete old content after a replace-after-upload switch.

### CLI confirmation

Node's `readline/promises` is the standard promise-based mechanism for line-oriented CLI prompts. For destructive commands, only interactive terminals should prompt. Non-interactive usage should require an explicit bypass flag (`--yes`) so scripts do not hang.

Implication for this repo: `artifacts remove <Publication URL>` prompts when stdin is interactive; `artifacts remove <Publication URL> --yes` skips the prompt. A declined prompt exits cleanly without contacting storage.

### Neon metadata

The existing metadata store already supports `markRemoved(opaqueId)` and maps it to `status = 'removed', removed_at = ..., updated_at = ...`. This is enough for v1 Removal because the PRD explicitly allows any authenticated Publisher with the Publication URL to remove it, so no owner check is required.

## Implementation Plan

1. Add `removePublication()` in `src/publication.ts`.
2. Authenticate Publisher Token but do not check publication ownership.
3. Parse the opaque ID from the Publication URL.
4. If missing, unknown, or already removed, return a not-found-shaped result and preserve viewer 404 semantics.
5. For active Publications, gather active locators, mark metadata removed, delete locators, and clear local state by `localSourcePath` when present.
6. Add `removePublicationFromEnvironment()` for CLI production wiring.
7. Add `artifacts remove <Publication URL> [--yes]` with interactive confirmation.

## References

1. Vercel Blob SDK docs, `del()` accepts one or multiple blob URLs and documents cache propagation considerations: https://vercel.com/docs/vercel-blob/using-blob-sdk
2. Vercel Blob product docs recommend treating blob objects as immutable to avoid caching issues: https://vercel.com/docs/vercel-blob
3. Node.js readline documentation and guides recommend `readline/promises` for async line-based CLI input: https://nodejs.org/api/readline.html
4. Neon serverless driver docs for TypeScript serverless Postgres access: https://neon.com/docs/serverless/serverless-driver
