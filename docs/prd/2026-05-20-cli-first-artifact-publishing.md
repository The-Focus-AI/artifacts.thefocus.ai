# PRD: CLI-first Artifact publishing

## Problem Statement

TheFocus.AI needs a brain-dead simple way for agents and team members to publish generated HTML output to the web and share it with clients. Today, sharing an agent-generated report, mockup, or static bundle requires ad hoc hosting steps, creates friction during last-minute fixes, and does not provide a consistent unlisted client-facing Publication URL.

The primary workflow is: publish an Artifact locally, share the Publication URL with a client, make immediate hotfixes for a short period if necessary, and then usually leave it alone. The service should support both a single HTML file and a single directory Artifact while avoiding a dashboard-heavy product surface.

## Solution

Build `artifacts.thefocus.ai` as a CLI-first publishing service for TheFocus.AI. A Publisher authenticates once with a verified `@thefocus.ai` email, receives a local Publisher Token, and then publishes with a simple command such as:

```bash
npx @the-focus-ai/artifacts publish ./dist
```

The command creates a Publication at a short opaque unlisted URL like:

```text
https://artifacts.thefocus.ai/a/Ab3xY9kQ
```

Anyone with the Publication URL can view the Artifact without logging in. Only authenticated TheFocus.AI Publishers can create, update, list, or remove Publications. A rolling 15-minute Revision Window allows repeated publishes from the same Local Source to update the same Publication URL for immediate hotfixes. After the Revision Window expires, publishing from that Local Source creates a new Publication unless the Publisher explicitly updates an existing Publication URL.

The product surface is intentionally small: CLI management, static Publication viewing, publishing API routes, one-time browser login for CLI token issuance, and a focused TheFocus.AI landing page that explains Artifacts as a dynamic publishing skill for agent-created HTML. There is no web dashboard in v1.

## User Stories

1. As a Publisher, I want to publish a generated HTML file with one command, so that I can share an agent-generated result without setting up hosting.
2. As a Publisher, I want to publish a generated directory Artifact with one command, so that CSS, JavaScript, images, and nested files work together.
3. As a Publisher, I want the CLI to print a Publication URL after publishing, so that I can immediately share it with a client.
4. As a client, I want to open a Publication URL without logging in, so that reviewing an Artifact is frictionless.
5. As a Publisher, I want Publication URLs to be unlisted and opaque, so that only people with the URL can discover the Artifact.
6. As a Publisher, I want no public listing of Publications, so that client artifacts are not browseable.
7. As a Publisher, I want the root service page to be super minimal and TheFocus.AI-branded, so that the domain looks intentional without becoming a product dashboard.
8. As a Publisher, I want the root page to link to the main TheFocus.AI site, so that visitors can understand the owner of the service.
9. As a Publisher, I want to authenticate once with my `@thefocus.ai` email, so that publishing remains secure without repeated login friction.
10. As a Publisher, I want login to open a browser or print a login URL, so that the CLI works in normal terminals and constrained environments.
11. As a Publisher, I want the CLI to store a local Publisher Token after login, so that later publishes are one command.
12. As an agent, I want to use `THEFOCUS_ARTIFACTS_TOKEN`, so that non-interactive publishing works without browser login.
13. As a Publisher, I want `THEFOCUS_ARTIFACTS_TOKEN` to override local config, so that automation can use explicit credentials.
14. As a Publisher, I want `artifacts whoami`, so that I can verify which email my CLI is publishing as.
15. As a Publisher, I want `artifacts logout`, so that I can remove the locally stored Publisher Token.
16. As a Publisher, I want only exact `@thefocus.ai` emails to receive Publisher Tokens, so that publishing is limited to TheFocus.AI team members.
17. As a non-TheFocus.AI user, I want a clear rejection after login, so that I understand publishing is limited to `@thefocus.ai` accounts.
18. As a Publisher, I want a single-file Artifact publish to upload only that HTML file, so that the command behavior is predictable.
19. As a Publisher, I want a directory Artifact to require a root `index.html` by default, so that the Entry Page is explicit and conventional.
20. As a Publisher, I want to optionally choose a different Entry Page for a directory Artifact, so that I can publish a directory whose main HTML file is not `index.html`.
21. As a Publisher, I want nested Artifact Paths to work, so that generated static sites and asset directories render correctly.
22. As a client, I want nested directory `index.html` behavior to work normally, so that paths like `/about/` can render when included in the Artifact.
23. As a client, I want missing Artifact Paths to return 404, so that the Publication behaves like simple static hosting.
24. As a Publisher, I want no directory listings, so that Artifact contents are only reachable by exact paths.
25. As a Publisher, I want obvious secret, dependency, and cache paths excluded by default, so that accidental publishes are less dangerous.
26. As a Publisher, I want hidden files excluded by default except `.well-known/`, so that common metadata and secrets are skipped while standard web paths can work.
27. As a Publisher, I want symlinks rejected by default, so that publishing cannot accidentally escape the intended local directory.
28. As a Publisher, I want local preflight limits, so that I do not accidentally upload huge directories or too many files.
29. As a Publisher, I want the CLI to warn when files are excluded, so that I know the hosted Artifact may not exactly match every local file.
30. As a Publisher, I want publishing to avoid git/build checks, so that the tool simply publishes the Artifact path I provide.
31. As a Publisher, I want the first publish from a Local Source to create a Publication, so that I get a client-facing URL quickly.
32. As a Publisher, I want repeated publishes from the same Local Source during the Revision Window to update the same Publication URL, so that hotfixes reach the client without sharing a new link.
33. As a Publisher, I want the Revision Window to last 15 minutes from the last successful push, so that each hotfix extends the immediate correction period.
34. As a Publisher, I want publishing after the Revision Window expires to create a new Publication, so that old client links are not accidentally overwritten later.
35. As a Publisher, I want the CLI to say when it created a new Publication because the previous Revision Window expired, so that I notice the URL changed.
36. As a Publisher, I want `--update <Publication URL>`, so that I can intentionally update an old Publication later.
37. As a Publisher, I want `--new`, so that I can force a fresh Publication even during the Revision Window.
38. As a Publisher, I want `--new` to become the active local state for that Local Source, so that subsequent hotfixes update the newest Publication.
39. As a Publisher, I want successful explicit updates to start a fresh Revision Window for the Local Source, so that subsequent immediate hotfixes are simple.
40. As a Publisher, I want updates to mirror the Local Source, so that files removed locally are removed from the hosted Artifact.
41. As a client, I want an update to avoid serving half-published directory contents, so that I either see the old Artifact or the new Artifact.
42. As a Publisher, I want no user-facing revision history, so that the product stays simple.
43. As a Publisher, I want no rollback feature in v1, so that the service does not become a version-management system.
44. As a Publisher, I want `artifacts remove <Publication URL>`, so that I can take down a Publication if I publish the wrong thing.
45. As a Publisher, I want interactive Removal to ask for confirmation, so that I do not accidentally remove a Publication.
46. As an agent, I want `artifacts remove <Publication URL> --yes`, so that scripted Removal can be non-interactive.
47. As a client, I want removed Publications to return 404, so that removed and unknown URLs are indistinguishable.
48. As a Publisher, I want Removal to delete Blob contents immediately, so that sensitive accidental publishes are cleaned up rather than only hidden.
49. As a Publisher, I want any authenticated Publisher with a Publication URL to be able to update or remove it, so that the small team can handle emergency changes without ownership bureaucracy.
50. As a Publisher, I want `artifacts list`, so that I can see my own Publications from the CLI.
51. As a Publisher, I want `artifacts list` to show last updated time, status, and Publication URL, so that I can find recent active and removed Publications.
52. As a Publisher, I want `artifacts list` to include removed Publications, so that I have a simple audit trail.
53. As a Publisher, I want `artifacts list` to show all my Publications in v1, so that I do not have to think about pagination yet.
54. As a Publisher, I want the service to store my verified Publisher email, so that my Publications can be listed and audited by email.
55. As a Publisher, I want Publication responses to use no-store caching, so that clients see hotfixes immediately.
56. As a Publisher, I want search engines blocked with robots rules and noindex headers, so that unlisted Publications are not indexed by compliant crawlers.
57. As a Publisher, I want no public CORS for publishing APIs, so that browser JavaScript from arbitrary origins cannot call the publishing surface.
58. As an Artifact author, I want no restrictive CSP in v1, so that generated HTML behaves like normal static HTML.
59. As a Publisher, I want no long-lived browser app session on the artifact origin, so that same-origin Artifact JavaScript does not share sensitive dashboard state.
60. As an operator, I want Artifact contents in Vercel Blob, so that static bytes are stored in infrastructure that fits the Vercel deployment.
61. As an operator, I want Publication metadata in Neon Postgres, so that Publication state, manifests, Publisher email, Revision Window state, and Removal state are queryable.
62. As an operator, I want Publisher Tokens stored hashed server-side, so that a metadata leak does not immediately expose usable long-lived tokens.
63. As a developer, I want the CLI distributed as `@the-focus-ai/artifacts` with an `artifacts` executable, so that local publishing works from arbitrary projects through npm.

## Implementation Decisions

- Build a CLI-first service. V1 includes CLI management, API routes, static Publication viewing, one-time login callback support, and a minimal TheFocus.AI landing page. V1 explicitly excludes a web dashboard.
- Use the glossary terms from `CONTEXT.md`: Artifact, Entry Page, Artifact Path, Publication, Unlisted, Publisher, Publisher Token, Revision Window, Removal, and Local Source.
- Deploy on Vercel and store Artifact contents in Vercel Blob, per ADR 0001.
- Store Publication metadata in Neon Postgres, per ADR 0002.
- Distribute the CLI as the npm package `@the-focus-ai/artifacts` with an `artifacts` executable, per ADR 0003.
- Use short opaque Publication URLs under `https://artifacts.thefocus.ai/a/{opaque}`. Product and CLI language should refer to the full Publication URL, not a token.
- Use same-origin serving for landing page, API, and Publications to keep v1 simple. Because Artifact JavaScript can run on the same origin, v1 must avoid long-lived authenticated browser dashboard/session state on that origin.
- The root page is focused, TheFocus.AI-branded, links to the main TheFocus.AI site, explains the agent-created HTML publishing workflow, links to `/llms.txt` and `/index.md`, and exposes no public Publication listing.
- Viewer access is unlisted and unauthenticated. Anyone with a Publication URL can view the active Artifact.
- Publisher access requires one-time browser login with a verified email exactly ending in `@thefocus.ai`. Non-matching emails are rejected and receive no Publisher Token.
- The API verifies email domain when issuing a Publisher Token. Later API requests trust valid Publisher Tokens.
- Publisher Tokens are long-lived until a future revocation mechanism exists. V1 `logout` removes local token state only.
- Store raw Publisher Tokens only on the client side; store hashed Publisher Tokens server-side.
- CLI local config/state lives under `~/.config/thefocus-artifacts/`. The token is stored in restricted local config. Local Source mappings live in local state.
- `THEFOCUS_ARTIFACTS_TOKEN` enables non-interactive publishing and overrides local config.
- CLI commands in v1: `login`, `logout`, `whoami`, `publish`, `remove`, and `list`.
- No separate `sync` command in v1. `publish` covers create and update behavior.
- `publish <path>` accepts one local HTML file or one local directory.
- Publishing a single HTML file uploads exactly that file. If it references local sibling assets, the CLI may warn and suggest publishing a directory instead.
- Publishing a directory uses root `index.html` as the default Entry Page. A Publisher may explicitly choose another HTML Entry Page.
- Directory Artifacts preserve nested Artifact Paths and serve them under the Publication URL. Directory listings are never exposed.
- Normal static hosting behavior applies for nested `index.html` paths. Missing paths return 404; no SPA fallback is provided in v1.
- Safety exclusions are built in and do not read `.gitignore` in v1. Exclusions include obvious secret, dependency, and cache paths, hidden paths except `.well-known/`, and similar dangerous defaults.
- Symlinks are rejected by default.
- Preflight upload guardrails: 25 MB max single file, 100 MB max total Artifact, and 1,000 max files.
- The default successful publish output prints the Publication URL and Revision Window expiry. Clipboard integration is out of scope.
- If safety exclusions apply, the CLI prints a concise warning and reserves detailed file lists for verbose output.
- The CLI performs no git status checks, no build checks, and no source project validation.
- Local Source identity is the canonical absolute filesystem path stored in local CLI state.
- A first publish from a Local Source creates a Publication and records local state.
- The Revision Window is rolling: 15 minutes from the last successful publish or update.
- A plain publish from the same Local Source during the Revision Window updates the same Publication URL.
- A plain publish after the Revision Window creates a new Publication and tells the Publisher why.
- `publish --new` always creates a new Publication and updates local state for that Local Source.
- `publish --update <Publication URL>` explicitly updates the named Publication and starts a fresh Revision Window for the Local Source. No confirmation is required for explicit updates.
- Any authenticated Publisher with a Publication URL can explicitly update or remove that Publication in v1.
- Updates mirror the Local Source. Remote files absent from the Local Source are removed from the hosted Artifact.
- Directory updates should be replace-after-upload internally: upload the complete new Artifact, switch the active manifest, then delete old Blob contents. This avoids half-published client views without exposing user-facing revision history.
- V1 has no rollback and no user-facing revision history.
- Removal disables the Publication URL, returns 404 to viewers, deletes Blob contents immediately, and marks metadata as removed.
- Interactive `remove` asks for confirmation; `--yes` skips confirmation. Removing a Publication clears matching local state if present.
- If local state points to a removed Publication, the next plain publish creates a new Publication.
- `list` shows the current Publisher's Publications only, not all team Publications. It includes active and removed Publications, shows last updated time, status, and Publication URL, and shows all results in v1.
- Store verified Publisher email in Publication metadata. V1 does not need Clerk user ID metadata unless implementation requires it.
- Serve Publication responses with `Cache-Control: no-store`.
- Provide `robots.txt` disallowing `/a/` and `X-Robots-Tag: noindex, nofollow` on Publication responses.
- Publishing APIs do not expose public CORS in v1.
- Do not set restrictive CSP on Publication responses in v1.

### Major modules to build

- **CLI command module**: parses commands and flags, formats output, handles interactivity, reads environment variables, and delegates real work to deeper modules.
- **Local credential/state module**: manages restricted config, Publisher Token lookup, environment override, canonical Local Source state, and Revision Window decisions.
- **Artifact packaging module**: converts one HTML file or one directory into an upload plan; applies safety exclusions; rejects symlinks; validates Entry Page; computes size/file-count guardrails; preserves Artifact Paths.
- **Publication decision module**: determines create vs update vs forced new based on Local Source state, Revision Window state, explicit flags, and server responses. This should be a deep module with a small testable interface.
- **Publishing API client module**: authenticates with Publisher Token, uploads Artifacts, requests Publication updates/removals, and lists Publications.
- **Authentication/token issuance module**: handles one-time browser login, exact `@thefocus.ai` validation, Publisher Token generation, hashed server storage, and CLI callback handoff.
- **Publication metadata module**: stores and queries Publication rows, Publisher email, status, last updated time, Revision Window fields, and active manifest references in Neon Postgres.
- **Blob storage module**: writes Artifact contents to Vercel Blob, supports replace-after-upload updates, and deletes Blob contents on Removal or post-update cleanup.
- **Static serving module**: resolves Publication URLs and Artifact Paths, serves active Blob contents with no-store/noindex headers, handles nested `index.html` behavior, and returns 404 for missing or removed Publications.
- **Minimal landing module**: renders the super-minimal TheFocus.AI landing page and main-site link without exposing Publication browsing.

## Testing Decisions

- Tests should focus on external behavior and stable module contracts, not implementation details such as internal helper names or exact database query text.
- The Artifact packaging module should have thorough unit tests for single-file publishing, directory publishing, Entry Page validation, nested Artifact Paths, hidden path exclusions, `.well-known/` behavior, symlink rejection, dangerous default exclusions, and upload guardrail failures.
- The Publication decision module should have unit tests for first publish, publish within Revision Window, rolling Revision Window extension, expired window creating a new Publication, `--new`, explicit `--update`, removed Publication fallback, and local state updates.
- The local credential/state module should have tests for config lookup, environment override, canonical path handling, state clearing after Removal, and missing/invalid token behavior.
- The authentication/token issuance module should have tests for exact `@thefocus.ai` acceptance, subdomain rejection, non-TheFocus.AI rejection, token hashing, and no token issuance on rejected login.
- The metadata module should have integration-style tests against a test database or isolated database adapter for Publication creation, update, Removal marking, list-by-Publisher-email, active/removed status, and manifest switching.
- The Blob storage module should have tests with a fake storage adapter for replace-after-upload sequencing and immediate Removal cleanup.
- The static serving module should have request-level tests for root Entry Page serving, nested Artifact Path serving, nested `index.html` behavior, missing path 404, removed Publication 404, no directory listing, no-store headers, and noindex headers.
- The CLI should have command-level tests using mocked API/local state for publish output, remove confirmation, `--yes`, list output, login URL fallback, logout, and whoami.
- End-to-end smoke tests should cover login with a test Publisher, publish directory Artifact, view Publication, hotfix within Revision Window, list Publication, remove Publication, and verify 404 after Removal.
- There is no prior application test suite in this fresh repo, so implementation should establish the first test conventions while keeping deep modules isolated from Vercel/Neon/Blob specifics where practical.

## Out of Scope

- Web dashboard or authenticated browser management UI.
- Public or unauthenticated Publication listing.
- Password-protected, authenticated, expiring, or signed client viewing links.
- Separate per-Publication management secrets.
- Cross-origin artifact serving on a separate viewing domain.
- Cloudflare Workers/R2 implementation for v1.
- SPA fallback to the Entry Page for missing paths.
- User-facing revision history or rollback.
- Clipboard integration.
- Git status checks, build orchestration, or project-specific validation.
- `.gitignore`-driven publishing behavior or custom ignore files in v1.
- Restrictive CSP for published Artifacts.
- Public CORS for publishing APIs.
- Server-side Publisher Token revocation.
- OS keychain storage.
- Standalone binary or Homebrew distribution.
- Title/label metadata for Publications.
- Pagination or filtering for `artifacts list` in v1.

## Further Notes

- The guiding principle is simplicity: one command to publish, stable client-facing Publication URLs for immediate hotfixes, and no dashboard unless a real need emerges.
- The service intentionally uses the word Publication URL in user-facing language. Avoid teaching users about internal URL tokens.
- Removal is intentionally destructive in v1 because a major Removal use case is accidental sensitive content exposure.
- Same-origin Artifact serving is a deliberate simplicity trade-off. Implementation must avoid introducing sensitive long-lived browser app state on `artifacts.thefocus.ai` while arbitrary Artifact JavaScript is served from that origin.
