# PRD: Doc Assets for Living Docs

## Problem Statement

Agents publish Living Docs that reference local images with relative Markdown paths (for example `![A](../assets/cards/….jpg)`). Today `doc publish` uploads only the Markdown string. The Review Link and View Link rewrite nothing and host nothing, so Reviewers see broken images even after the editor learned to render `<img>` and tables. Absolute URLs work only if the agent already hosted the files elsewhere, which breaks the normal Local Source layout.

## Solution

On `artifacts doc publish <file.md>`, discover relative **image** references, upload them as **Doc Assets** on Vercel Blob bound to that Living Doc, rewrite the stored Markdown to absolute Unlisted URLs under the same View Link prefix (`/d/{opaqueId}/…`), and serve those bytes on nested View paths. Bare `/d/{opaqueId}` remains the rendered Living Doc View. Missing local files fail the publish unless `--force` is passed. Reviewer upload is out of scope for v1.

Glossary and architecture follow `CONTEXT.md` and [ADR 0006](../adr/0006-doc-assets-on-living-doc-publish.md).

## User Stories

1. As an agent, I want `doc publish` to upload images referenced by relative Markdown paths, so that Reviewers see the same figures I authored locally.
2. As an agent, I want relative paths resolved from the Markdown file’s directory, so that `./img.png` and nested folders work.
3. As an agent, I want `..` segments allowed when resolving Doc Assets, so that common `../assets/…` layouts work.
4. As a Publisher, I want absolute local filesystem paths rejected as Doc Asset sources, so that publish cannot pull arbitrary machine paths from crafted Markdown.
5. As a Publisher, I want symlinks rejected as Doc Asset sources, so that publish cannot escape the intended tree (same posture as directory Artifacts).
6. As an agent, I want only Markdown image references (`![…](…)`) to become Doc Assets in v1, so that ordinary file links do not unexpectedly upload.
7. As an agent, I want already-absolute `http(s)` image URLs left unchanged, so that externally hosted images keep working.
8. As an agent, I want the stored Living Doc Markdown rewritten to hosted Doc Asset URLs, so that View and Review Links load images without Local Source paths.
   8a. As an agent, I want YAML front matter preserved through `doc publish` and Doc Asset rewrite, so that metadata in the Local Source file is never stripped from the hosted Living Doc.
9. As a Reviewer, I want images in the Review editor to load from hosted Doc Asset URLs, so that WYSIWYG review matches the author’s intent.
10. As a viewer holding a View Link, I want images to render in the read-only View, so that I can read the doc without the Review Link.
11. As a viewer, I want Doc Assets addressed under `/d/{opaqueId}/{assetPath}`, so that one opaque id covers the Living Doc and its images.
12. As a viewer, I want bare `/d/{opaqueId}` to remain the rendered Markdown View, so that existing View Links keep their meaning.
13. As a viewer, I want a missing Doc Asset path to return 404, so that there is no directory listing of assets.
14. As a viewer, I want Doc Asset responses to be Unlisted (no-store, noindex), so that image URLs match Publication safety posture.
15. As an agent, I want missing local image files to fail `doc publish` with a clear list of paths, so that I do not ship a Review Link with silent broken images.
16. As an agent, I want `doc publish --force` to continue when some local images are missing, so that I can still share a draft when assets are incomplete.
17. As an agent, I want `--force` to leave missing refs unrewritten (or clearly not hosted), so that I can see which images never uploaded.
18. As a Publisher, I want Doc Asset preflight limits aligned with Publication limits (25 MB per file, 100 MB total, 1,000 files), so that abuse ceilings stay familiar.
19. As a Publisher, I want Doc Assets deleted when I remove a Living Doc, so that sensitive images are not left in Blob after Removal.
20. As a client, I want a removed Living Doc’s Doc Asset URLs to 404, so that removed and unknown resources are indistinguishable.
21. As an agent, I want `doc pull` to return the rewritten Markdown (hosted image URLs), so that the online Living Doc remains the source of truth.
22. As an agent, I want Doc Assets uploaded only at publish time in v1, so that holding a Review Link never grants Blob upload.
23. As a Publisher, I want Doc Assets not modelled as Artifacts or Publications, so that Living Docs stay a distinct collaborative entity.
24. As an operator, I want Doc Asset bytes in Vercel Blob and Markdown in Neon, so that storage matches ADRs 0001, 0002, and 0005.
25. As a developer, I want replace-after-upload Blob semantics for Doc Assets, so that clients do not observe half-written image bytes.
26. As a Reviewer, I want images inside Markdown tables to load after publish, so that card/comparison layouts work end-to-end.
27. As an agent, I want duplicate relative references to the same file to upload once, so that publish stays efficient.
28. As a Publisher, I want normalized stable `assetPath` segments in hosted URLs, so that the same logical file has one address for that Living Doc.
29. As a developer, I want content types for Doc Assets derived from file extensions like Publications do for images, so that browsers render PNG/JPEG/GIF/WebP/SVG correctly.
30. As an agent, I want publish to fail clearly if Blob upload fails mid-flight, so that I do not get a Living Doc that claims hosted URLs for missing bytes.
31. As a Publisher, I want Removal to remain Publisher-authenticated, so that Doc Asset cleanup cannot be triggered by a Review Link alone.
32. As a developer, I want smoke coverage for publish-with-images → view image URL → remove → 404, so that the loop is verified beyond unit tests.

## Implementation Decisions

- Follow ADR 0006 and glossary terms: Living Doc, Doc Asset, View Link, Review Link, Publisher, Removal, Local Source, Unlisted. Do not call Doc Assets Artifacts or Artifact Paths.
- **Doc Asset collector (deep module):** Input = Markdown text + absolute path to the `.md` file + options (`force`). Output = list of `{ relativeRef, absolutePath, assetPath }` plus errors for missing/rejected paths. Image refs only; resolve from `dirname(md)`; allow `..`; reject absolute local paths and symlinks; enforce Publication-equivalent size/count limits; on missing files error unless `force`.
- **Doc Asset packager/uploader (deep module):** Input = Living Doc opaque id + collected files. Writes Blob under a Living-Doc-scoped key space (not `artifacts/` Publication prefix). Returns map `assetPath → publicUrl` for `/d/{opaqueId}/{assetPath}`. Use replace-after-upload; dedupe identical `assetPath`.
- **Markdown rewriter (deep module):** Input = Markdown + map of original relative refs (or resolved asset paths) → hosted URLs. Output = Markdown with those image targets rewritten; leave `http(s)` alone; do not rewrite non-image links in v1.
- **`doc publish` orchestration:** Authenticated publish becomes multi-part (or equivalent): create Living Doc metadata/opaque ids, upload Doc Assets, rewrite Markdown, persist rewritten Markdown as `currentMarkdown`. Prefer an order that never leaves rewritten URLs pointing at non-existent Blob objects (upload before final Markdown save, or transactional equivalent with cleanup on failure).
- **Doc Asset serving:** Extend View routing so nested `/d/{opaqueId}/{assetPath}` serves Blob bytes with Unlisted headers; bare `/d/{opaqueId}` keeps HTML View. No directory listing. Unknown/removed → 404.
- **Removal cleanup:** `doc remove` / Living Doc Removal deletes Doc Asset Blob locators for that opaque id after marking the doc removed (same expectation as Publication Removal).
- **CLI:** `artifacts doc publish <file.md> [--force] [--title …]`. Print View/Review URLs as today; on failure from missing assets, print every missing path.
- **API:** Publisher-authenticated publish accepts Markdown plus Doc Asset file parts (exact transport left to implementer; must not require Review Link auth).
- **Schema:** Prefer Blob + opaque id path identity for v1; add Neon inventory only if required for reliable Removal listing. Markdown/Versions remain in Neon.
- Living Doc republish/update-in-place remains out of this PRD; each publish still creates a new Living Doc unless a later PRD changes that.

## Testing Decisions

- Test external behavior and module contracts, not internal helper names or exact Blob key string formatting unless that string is part of the public URL contract.
- **Test the collector** in isolation: `..` resolution, symlink reject, absolute reject, image-only filtering, missing+force, size/count limits, dedupe.
- **Test the rewriter** in isolation: relative images rewritten; absolute URLs untouched; non-image links untouched; table-embedded images rewritten.
- **Test serving** at the request handler level: active asset 200 + content-type; missing 404; removed Living Doc asset 404; bare `/d/{id}` still HTML View; noindex/no-store.
- **Test publish orchestration** with fake Blob + in-memory Living Doc store: happy path rewrite; missing fails; `--force` publishes; upload failure does not leave a successful publish with dangling URLs.
- **Test Removal** deletes Doc Assets (fake content store assertions), matching Publication removal tests’ style.
- Prior art: `tests/living-doc*.test.ts`, `tests/revision-window.test.ts` (replace-after-upload / mirror), `tests/safety-preflight.test.ts` (limits/exclusions), `tests/storage-foundation.test.ts` (Blob path helpers).

## Out of Scope

- Reviewer upload or paste-to-Blob from the Review Link
- Non-image relative links (PDF, video, arbitrary attachments)
- HTML `<img src>` discovery beyond Markdown image syntax (unless trivial to include without scope creep; not required)
- Living Doc update-in-place / Revision Window for docs
- Rewriting pulled Markdown back to Local Source relative paths
- CDN caching / long-lived cache headers for Doc Assets
- Public asset listing or search
- Changing the TipTap editor beyond consuming already-hosted URLs

## Further Notes

- Real motivating doc used table cells containing relative card images; editor table/image support is already on the front-matter/tables branch and is complementary, not a substitute for hosting.
- Preview deployments need `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` (and related secrets) in the Vercel Preview environment for end-to-end smoke.
- After this PRD is accepted for implementation, split into vertical issues with `to-issues`.
