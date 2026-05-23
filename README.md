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

Install/run the CLI through npm or the repo-local script:

```bash
npx @the-focus-ai/artifacts publish ./artifact.html
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

Publisher Tokens are issued only to verified emails ending exactly in `@thefocus.ai`, are stored hashed server-side, and can be stored locally with `artifacts login --token <token>` or supplied non-interactively with `THEFOCUS_ARTIFACTS_TOKEN` (which overrides local config). Local CLI token state is stored under `~/.config/thefocus-artifacts/` with restricted file permissions where supported; `artifacts whoami` validates the active token through the hosted Artifacts API, `artifacts list` shows the current Publisher's active and removed Publications, and `artifacts logout` removes local token state.

Normal npm CLI usage only needs a Publisher Token. Infrastructure secrets such as `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are required only for local development of the server/Vercel functions or deployed server-side API routes; publishers and agents running `npx @the-focus-ai/artifacts ...` should not set those secrets locally.

Remove a Publication with an interactive confirmation, or pass `--yes` for non-interactive scripted Removal:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ --yes
```

Removal marks the Publication as removed, clears matching Local Source state when present, deletes the active Artifact contents from Blob storage, and makes the Publication URL return 404.

Directory Artifacts require a root `index.html` by default and preserve nested Artifact Paths:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts publish ./dist
```

Use `--entry-page path/to/page.html` to choose a different HTML Entry Page inside a directory Artifact. Use `--new` to force a fresh Publication during the Revision Window, or `--update <Publication URL>` to intentionally update an older active Publication URL.

Other CLI management commands:

```bash
pnpm artifacts list
pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ
pnpm artifacts remove https://artifacts.thefocus.ai/a/Ab3xY9kQ --yes
pnpm artifacts logout
```

Packaging applies built-in safety rules before upload: obvious secret, dependency, cache, and hidden paths are excluded by default, except `.well-known/`; `.gitignore` is not read in v1; symlinks are rejected; and preflight fails before upload if any file exceeds 25 MB, total Artifact size exceeds 100 MB, or the Artifact has more than 1,000 files. Exclusion output is concise by default; add `--verbose` to print excluded paths.

`ARTIFACTS_PUBLIC_BASE_URL` defaults to `https://artifacts.thefocus.ai`; set it only when publishing against a Vercel Preview or another host that serves this app. Published Artifacts are served by the Vercel rewrite from `/a/{opaque}` and nested `/a/{opaque}/{path}` URLs to the API functions with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` headers.
