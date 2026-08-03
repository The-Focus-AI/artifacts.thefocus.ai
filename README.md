# artifacts.thefocus.ai

CLI-first Artifact publishing for TheFocus.AI.

Artifacts is a dynamic publishing skill for AI agents that create HTML reports, prototypes, mockups, visualizations, and static bundles. It gives those agent-created files a stable unlisted Publication URL that can be shared with clients or collaborators.

The CLI is packaged as `@the-focus-ai/artifacts` and exposes the `artifacts` executable:

```bash
npx @the-focus-ai/artifacts publish ./dist
```

## Development

This repo uses mise and pnpm:

```bash
mise trust
mise install
mise run setup
mise run install
mise run lint
mise run test
```

See [docs/development.md](docs/development.md) for the Neon/Postgres and Vercel Blob environment contract, migration setup, and local fake adapter notes.

See [docs/deploy.md](docs/deploy.md) for Vercel project, custom domain, pull-request Preview deployment, and environment configuration. See [docs/smoke-test.md](docs/smoke-test.md) for the integrated smoke flow and [docs/release.md](docs/release.md) for npm release steps.

## Publishing Artifacts

Use Artifacts when an agent has produced a local HTML file or static directory and needs to return a URL instead of attaching files or asking a human to set up hosting.

Install the agent skill (recommended for coding agents):

```bash
npx skills add The-Focus-AI/artifacts.thefocus.ai --skill artifacts -g
```

The hosted skill is published at [https://artifacts.thefocus.ai/skill.md](https://artifacts.thefocus.ai/skill.md). The canonical in-repo copy lives at `skills/artifacts/SKILL.md` and must stay identical to `public/skill.md`.

Install/run the CLI through npm or the repo-local script:

```bash
npx @the-focus-ai/artifacts publish ./artifact.html
npx @the-focus-ai/artifacts publish ./report.html --title "Q2 Results"
pnpm artifacts publish ./artifact.html
pnpm artifacts publish ./dist --open
pbpaste | pnpm artifacts publish - --open
```

Log in once with a browser, or store a pre-issued Publisher Token non-interactively:

```bash
pnpm artifacts login
pnpm artifacts login --token tfai_pub_...
pnpm artifacts whoami
```

The publishing path accepts one local HTML file, one local directory, or standard input (`-`), and returns a canonical unlisted Publication URL. In agent workflows, publish the generated Artifact and include the printed URL in the final response:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts publish ./artifact.html
```

Pass `--title "Report Name"` to set a human-readable title for the Publication (visible via `artifacts list`).

Publisher Tokens are issued only to verified emails ending exactly in `@thefocus.ai`, are stored hashed server-side, and can be stored locally with `npx @the-focus-ai/artifacts login --token <token>` or supplied non-interactively with `THEFOCUS_ARTIFACTS_TOKEN` (which overrides local config). Local CLI token state is stored under `~/.config/thefocus-artifacts/` with restricted file permissions where supported; `npx @the-focus-ai/artifacts whoami` validates the active token through the hosted Artifacts API, `npx @the-focus-ai/artifacts list` shows the current Publisher's active and removed Publications (with titles), and `npx @the-focus-ai/artifacts logout` removes local token state.

Normal npm CLI usage only needs a Publisher Token. Infrastructure secrets such as `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are required only for local development of the server/Vercel functions or deployed server-side API routes; publishers and agents running `npx @the-focus-ai/artifacts ...` should not set those secrets locally.

Remove a Publication with an interactive confirmation, or pass `--yes` for non-interactive scripted Removal:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ/ --yes
```

Removal marks the Publication as removed, clears matching Local Source state when present, deletes the active Artifact contents from Blob storage, and makes the Publication URL return 404.

Directory Artifacts require a root `index.html` by default and preserve nested Artifact Paths:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts publish ./dist
```

Use `--entry-page path/to/page.html` to choose a different HTML Entry Page inside a directory Artifact. Use `--title "Report Name"` to set a human-readable title (shown in `list`). Use `--new` to force a fresh Publication during the Revision Window, or `--update <Publication URL>` to intentionally update an older active Publication URL.

Other CLI management commands:

```bash
pnpm artifacts list
pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ/
pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ/ --yes
pnpm artifacts logout
```

Packaging applies built-in safety rules before upload: obvious secret, dependency, cache, and hidden paths are excluded by default, except `.well-known/`; `.gitignore` is not read in v1; symlinks are rejected; and preflight fails before upload if any file exceeds 25 MB, total Artifact size exceeds 100 MB, or the Artifact has more than 1,000 files. Exclusion output is concise by default; add `--verbose` to print excluded paths.

`ARTIFACTS_PUBLIC_BASE_URL` defaults to `https://artifacts.thefocus.ai`; set it only when publishing against a Vercel Preview or another host that serves this app. Published Artifacts are served by the Vercel rewrite from `/a/{opaque}` and nested `/a/{opaque}/{path}` URLs to the API functions with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` headers.

### Trailing slashes

Every URL the CLI, the MCP tools, and the API return for a Publication root or a Living Doc ends in a slash — `https://artifacts.thefocus.ai/a/Ab3xY9kQ/`, not `/a/Ab3xY9kQ`. Without it, a relative link in the Entry Page (`assets/app.css`) resolves against the site root instead of the Publication and 404s. Requests to the bare form still work: they answer `308` to the trailing-slash form, so URLs shared before this was canonical keep serving and their relative links start resolving.

## Living Docs

A **Living Doc** is a collaborative Markdown document an agent publishes so a human can edit it and comment on it, then the agent pulls that feedback back to continue the work. Unlike a Publication (read-only, static), a Living Doc is mutable and two-party. See [docs/adr/0005-living-docs-agent-human-review-loop.md](docs/adr/0005-living-docs-agent-human-review-loop.md) for the design and [CONTEXT.md](CONTEXT.md) for the vocabulary.

Publishing a Living Doc returns two URLs: a read-only **View Link** (`/d/{opaque}/`) and a capability **Review Link** (`/r/{review}/`). Hand the Review Link to whoever should give feedback — no login required. The Review Link opens a WYSIWYG editor (Tiptap) where the Reviewer edits the rendered document directly; edits autosave continuously as Markdown. Selecting text pops up an inline Comment button, and pending agent Suggestions render in the document as tracked changes (strikethrough original, replacement alongside, accept/reject buttons), falling back to sidebar cards when a Suggestion's anchor spans multiple blocks.

**YAML front matter is part of the Living Doc.** `doc publish` uploads the file as-is (including a leading `---` … `---` block). Image rewrite and Doc Asset upload never strip front matter. Prefer a `title:` field there when the file has one; `--title` still overrides. The View Link renders the Markdown body only so fences are not shown as horizontal rules — the stored Markdown and `doc pull` output keep the front matter intact.

The agent drives the loop through `artifacts doc` subcommands, which print JSON:

```bash
# Publish a Markdown file (front matter preserved); prints
# { opaqueId, reviewId, viewUrl, reviewUrl, title }
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts doc publish ./proposal.md --title "Proposal"

# Pull feedback. Cuts an immutable Version and prints the current Markdown,
# a diff versus the previous Version, and open reviewer Comments.
pnpm artifacts doc pull https://artifacts.thefocus.ai/d/Ab3xY9kQ/

# Respond with span-anchored Suggestions and replies to Comments.
# Body JSON: { "suggestions": [{ "anchorQuote": "...", "replacement": "...",
#                                "note": "...", "anchorStart": 123 }],
#             "replies": [{ "parentCommentId": "...", "body": "..." }] }
# anchorStart (optional) is the quote's character offset in the pulled
# Markdown; include it whenever the quoted text could appear more than once,
# since it decides which occurrence an accepted Suggestion replaces.
pnpm artifacts doc respond https://artifacts.thefocus.ai/d/Ab3xY9kQ/ --body feedback.json
cat feedback.json | pnpm artifacts doc respond https://artifacts.thefocus.ai/d/Ab3xY9kQ/

# List your Living Docs
pnpm artifacts doc list

# Remove a Living Doc (disables both the View Link and the Review Link)
pnpm artifacts doc remove https://artifacts.thefocus.ai/d/Ab3xY9kQ/ --yes
```

Suggestions are never applied automatically — the Reviewer accepts or rejects each one in the editor, and accepting applies the change to the live Markdown at the anchored quote (nearest `anchorStart` when it matches more than once). If the Reviewer has edited the quoted text away, the Suggestion stays pending so its replacement remains visible rather than being marked accepted without applying. Each `doc pull` advances the Version number so both sides can refer back to "as of Version 3." Because the review surface is reachable by anyone holding the Review Link, all inputs are size-capped server-side (2 MB for the Markdown, 64 KB for comments, suggestion text, and replies). Living Docs require `migrations/0005_create_living_docs.sql`.

## MCP endpoint

`https://artifacts.thefocus.ai/mcp` exposes the same publishing and Living Doc operations as MCP tools, for agents that speak MCP instead of shelling out to the CLI. It is an addition to the CLI, not a replacement — see [docs/adr/0007-remote-mcp-endpoint-over-publisher-tokens.md](docs/adr/0007-remote-mcp-endpoint-over-publisher-tokens.md) and [docs/adr/0008-mcp-clients-log-in-with-oauth.md](docs/adr/0008-mcp-clients-log-in-with-oauth.md).

**Log in through the browser.** Point any MCP client at the URL with no credential and it runs the OAuth flow itself — discovers the authorization server, registers, opens your browser to sign in with Clerk, and shows a consent page naming the client:

```bash
claude mcp add --transport http artifacts https://artifacts.thefocus.ai/mcp
```

```json
{
  "mcpServers": {
    "artifacts": {
      "type": "http",
      "url": "https://artifacts.thefocus.ai/mcp"
    }
  }
}
```

Approving issues an access token the client stores and refreshes on its own; nothing is pasted by hand. Login is limited to verified `@thefocus.ai` emails, the same rule as `artifacts login`.

**Or paste a token**, for clients that only support a static header:

```bash
pnpm artifacts token create --for mcp --label "claude code"
```

```bash
claude mcp add --transport http artifacts https://artifacts.thefocus.ai/mcp \
  --header "Authorization: Bearer tfai_mcp_..."
```

Tools: `publish_artifact`, `update_artifact`, `remove_artifact`, `list_artifacts`, `publish_doc`, `pull_doc`, `respond_doc`, `remove_doc`, `list_docs`, `whoami`.

Two differences from the CLI, both because the endpoint cannot read your filesystem:

- **Artifact content travels inline.** `publish_artifact` takes `html` for a single page, or `files` (each with `text` or `contentBase64`) for a bundle with a root `index.html`. This suits pages and small bundles; publish large directories with the CLI. Living Doc images must likewise be supplied as `assets` — `publish_doc` reports any Markdown image reference with no matching asset.
- **The Revision Window does not apply.** There is no Local Source to match, so `publish_artifact` always creates a new Publication. To change one in place, call `update_artifact` with its Publication URL.

### Publisher Tokens for MCP clients

MCP clients store credentials in configuration files that are often committed or synced, so mint a separate token per client rather than reusing your CLI login:

```bash
pnpm artifacts token create --for mcp --label "cursor"   # shown once
pnpm artifacts token list
pnpm artifacts token revoke 3f9a1c2e5b7d --yes
```

`token list` shows a Token Id — a prefix of the stored hash, safe to paste into an issue — which is what `token revoke` takes. Revoking an `mcp` token does not affect your CLI login, and takes effect on the next request. `/mcp` also accepts an ordinary `tfai_pub_` token, so an existing login keeps working. Requires `migrations/0006_add_publisher_token_kind_and_revocation.sql`.

### OAuth details

`/mcp` is an OAuth 2.1 protected resource and the site is its authorization server. Discovery documents live at `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) and `/.well-known/oauth-authorization-server`; the endpoints are `/oauth/authorize`, `/oauth/token`, and `/oauth/register`.

- Public clients with PKCE (`S256` required, `plain` refused). No client secrets.
- Clients identified by a **Client ID Metadata Document** are preferred, per `STD-009` R2 §3.12 — pass an https `client_id` URL whose document's `client_id` equals that URL. Dynamic Client Registration at `/oauth/register` remains for clients that have not moved.
- Tokens are audience-bound to `https://artifacts.thefocus.ai/mcp` via the `resource` parameter; a token minted for anything else is refused.
- Access tokens last an hour, refresh tokens thirty days and rotate on every use.

OAuth requires `migrations/0007_create_oauth_tables.sql` and the Clerk environment variables already used by `artifacts login`.
