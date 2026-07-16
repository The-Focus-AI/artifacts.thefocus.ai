# Doc Assets are uploaded with Living Doc publish

## Status

accepted

## Decision

When a Publisher runs `artifacts doc publish` on a Markdown file, relative **image**
references become **Doc Assets**: binary files hosted with that Living Doc on Vercel Blob.
The stored Markdown is rewritten to absolute Unlisted URLs under the same View Link prefix
(`/d/{opaqueId}/…`). Bare `/d/{opaqueId}` remains the rendered View; nested paths serve Doc
Asset bytes. Doc Assets are not Artifacts and are not Publications. Image rewrite touches only
matching `![…](…)` targets; YAML front matter and the rest of the file are never stripped.

v1 scope:

- Upload only at publish time (Reviewer upload is out of scope).
- Image references only (`![…](…)`); ordinary file links are ignored.
- Resolve paths from the Markdown file’s directory; `..` is allowed; reject absolute local
  paths and symlinks.
- Missing local files fail the publish; `--force` continues without those assets.
- Size/count preflight reuses Publication limits (25 MB per file, 100 MB total, 1,000 files).
- Removal of a Living Doc deletes its Doc Asset Blob contents, matching Publication Removal.
- Blob writes follow replace-after-upload (new keys, then drop unreferenced old bytes), not
  in-place mutation of a single Blob path.

## Considered options and why they were rejected

- **Markdown-only / require absolute URLs.** Rejected: agents already write relative
  `../assets/…` paths; forcing a separate hosting step recreates broken Review Links.
- **Dual-publish as a Publication for images.** Rejected: a Living Doc is not an Artifact;
  two URLs and two lifecycles drift and muddy the glossary.
- **Separate URL prefix (e.g. `/da/…`).** Rejected: Publications already teach
  `/a/{opaqueId}/{path}`; nesting Doc Assets under `/d/{opaqueId}/{path}` keeps one opaque
  capability surface for the View Link.
- **Reviewer upload in v1.** Rejected: the Review Link is an unauthenticated bearer
  capability; open upload would fill Blob for anyone holding the link. Publish-time only
  keeps the Publisher/agent as the trust boundary.
- **Keep relative paths in stored Markdown.** Rejected: the hosted View/Review surfaces
  cannot resolve Local Source paths; rewriting to hosted URLs makes the online doc the
  source of truth.

## Consequences

- `doc publish` must become a multi-file upload (Markdown + Doc Assets), not a JSON string
  of Markdown alone.
- View serving must route nested `/d/{opaqueId}/{assetPath}` to Blob with the same
  Unlisted/no-store posture as Publications.
- Neon continues to hold Markdown (and Versions); Doc Asset bytes live in Blob, consistent
  with ADRs 0001, 0002, and 0005.
- Agents that `doc pull` receive rewritten absolute image URLs, not the original relative
  Local Source paths.
- Living Doc republish/update-in-place remains absent today (each publish creates a new
  Living Doc); Doc Asset URL stability across updates can follow Publication’s
  replace-after-upload pattern when that loop exists.
