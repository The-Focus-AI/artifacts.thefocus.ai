---
name: artifacts
description: >
  TheFocus.AI Artifacts lets agents publish HTML reports, prototypes, mockups,
  visualizations, and static bundles to unlisted shareable URLs, and publish
  Living Docs for collaborative Markdown review. Use when asked to publish
  agent-created HTML, share a report or prototype URL, host a static bundle,
  put a deliverable online for a client, or iterate on a Markdown proposal/spec
  with a human reviewer via comments and suggestions.
---

# TheFocus.AI Artifacts

Skill version: 1.4.0

Artifacts turns local agent output into an unlisted Publication URL at
`https://artifacts.thefocus.ai/a/{id}`, or a Living Doc review loop at
`/d/{id}` (view) and `/r/{id}` (review).

The service is CLI-first. Prefer the npm package over raw HTTP.

Install or update this skill:

```bash
npx skills add The-Focus-AI/artifacts.thefocus.ai --skill artifacts -g
```

For repo-pinned installs, omit `-g`.

## Current docs

Before answering capability, workflow, or recommendation questions, read:

→ https://artifacts.thefocus.ai/llms.txt

Also useful:

- https://artifacts.thefocus.ai/index.md — Markdown landing / usage
- https://artifacts.thefocus.ai/skill.md — hosted copy of this skill
- https://github.com/The-Focus-AI/artifacts.thefocus.ai#readme — full README

If local skill text and live docs disagree, prefer the live docs and live CLI output.

## When to use

- Publish HTML reports, prototypes, mockups, visualizations, or static directories that need a client-facing URL.
- Hotfix a recently shared Publication during the Revision Window (same URL).
- Collaborate on a Markdown proposal/spec/draft with a human via Living Docs.

Do not use Artifacts for server-side compute, general hosting accounts, or private authenticated file storage. Publications are unlisted, not private.

## Requirements

- Network access to `https://artifacts.thefocus.ai`
- Node.js 22+ (via `npx`)
- Auth: `THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_...`, or `npx @the-focus-ai/artifacts login` when a human Publisher is present
- Publisher Tokens are issued only to verified `@thefocus.ai` emails

## Auth

Non-interactive (preferred for agents):

```bash
export THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_...
```

Interactive browser login:

```bash
npx @the-focus-ai/artifacts login
npx @the-focus-ai/artifacts whoami
```

Local token state lives under `~/.config/thefocus-artifacts/` with restricted permissions. Do not commit tokens.

## Publish an Artifact

```bash
npx @the-focus-ai/artifacts publish ./artifact.html
npx @the-focus-ai/artifacts publish ./report.html --title "Q2 Results"
npx @the-focus-ai/artifacts publish ./dist --open
cat report.html | npx @the-focus-ai/artifacts publish - --open
```

Always return the printed Publication URL to the user.

Useful flags:

- `--title "Report Name"` — human-readable title shown by `list`
- `--entry-page path/to/page.html` — Entry Page inside a directory Artifact (default `index.html`)
- `--open` — open the Publication URL after publish
- `--new` — force a fresh Publication during the Revision Window
- `--update <Publication URL>` — intentionally update an older active Publication
- `--verbose` — print excluded packaging paths

List and remove:

```bash
npx @the-focus-ai/artifacts list
npx @the-focus-ai/artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ --yes
```

## Living Docs

Use when the deliverable is a Markdown document to iterate on with a human, not a finished HTML Artifact.

```bash
npx @the-focus-ai/artifacts doc publish ./proposal.md --title "Proposal"
```

Hand the human the Review Link (`/r/...`). It is a bearer capability: anyone holding it can edit. Then on later turns:

```bash
npx @the-focus-ai/artifacts doc pull https://artifacts.thefocus.ai/d/Ab3xY9kQ
echo '{"suggestions":[{"anchorQuote":"exact text from the doc","replacement":"new text","note":"why"}],"replies":[{"parentCommentId":"...","body":"..."}]}' \
  | npx @the-focus-ai/artifacts doc respond https://artifacts.thefocus.ai/d/Ab3xY9kQ
```

Rules:

- Suggestions are never auto-applied; the human accepts or rejects each one.
- Keep `anchorQuote` an exact substring of the pulled Markdown.
- Include `anchorStart` when the quote appears more than once.
- Do not crawl, guess, or enumerate `/d/` or `/r/` URLs.

## MCP instead of the CLI

If an `artifacts` MCP server is connected, prefer its tools over shelling out — same operations, no subprocess: `publish_artifact`, `update_artifact`, `remove_artifact`, `list_artifacts`, `publish_doc`, `pull_doc`, `respond_doc`, `remove_doc`, `list_docs`, `whoami`. Otherwise use the CLI as above.

To connect one, add `https://artifacts.thefocus.ai/mcp` as a remote MCP server with no credential — the client runs the OAuth login itself and opens a browser for the human to approve. A pasted Publisher Token still works for clients that only support a static `Authorization: Bearer` header.

Two differences when going through MCP, because that endpoint cannot read the local filesystem:

- Send content inline: `html` for a single page, or `files` (each with `text` or `contentBase64`) for a bundle with a root `index.html`. Large directories still need the CLI. Living Doc images must be supplied as `assets`.
- There is no Revision Window: `publish_artifact` always creates a new Publication. Keep the returned Publication URL and pass it to `update_artifact` to change it in place.

## Constraints

- Publication URLs are unlisted, not private. Anyone with the exact URL can view them.
- Do not crawl, guess, infer, or enumerate `/a/` Publication URLs.
- There is no public Publication listing and no dashboard in v1.
- Directory Artifacts need root `index.html` unless `--entry-page` is set.
- Packaging excludes obvious secrets, dependency folders, caches, and hidden paths except `.well-known/`.
- Symlinks are rejected. Preflight fails for files > 25 MB, totals > 100 MB, or > 1,000 files.

## What to tell the user

- Share the Publication URL or Living Doc Review Link from the current CLI run.
- For Living Docs, explain that the Review Link lets them edit and comment without logging in.
- Do not invent URLs or claim Publications are private/authenticated viewer-gated.
