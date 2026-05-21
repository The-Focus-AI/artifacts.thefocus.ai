# artifacts.thefocus.ai

CLI-first Artifact publishing for TheFocus.AI.

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

See [docs/deploy.md](docs/deploy.md) for Vercel project, custom domain, pull-request Preview deployment, and live smoke-test instructions.

## Publishing Artifacts

The publishing path accepts one local HTML file or one local directory and returns a canonical unlisted Publication URL:

```bash
ARTIFACTS_PUBLIC_BASE_URL=https://your-vercel-host.example \
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts publish ./artifact.html
```

Publisher Tokens are issued only to verified emails ending exactly in `@thefocus.ai`, are stored hashed server-side, and can be stored locally with `artifacts login --token <token>` or supplied non-interactively with `THEFOCUS_ARTIFACTS_TOKEN` (which overrides local config). Local CLI token state is stored under `~/.config/thefocus-artifacts/` with restricted file permissions where supported; `artifacts whoami` validates the active token, `artifacts list` shows the current Publisher's active and removed Publications, and `artifacts logout` removes local token state.

Directory Artifacts require a root `index.html` by default and preserve nested Artifact Paths:

```bash
ARTIFACTS_PUBLIC_BASE_URL=https://your-vercel-host.example \
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- pnpm artifacts publish ./dist
```

Use `--entry-page path/to/page.html` to choose a different HTML Entry Page inside a directory Artifact.

Packaging applies built-in safety rules before upload: obvious secret, dependency, cache, and hidden paths are excluded by default, except `.well-known/`; `.gitignore` is not read in v1; symlinks are rejected; and preflight fails before upload if any file exceeds 25 MB, total Artifact size exceeds 100 MB, or the Artifact has more than 1,000 files. Exclusion output is concise by default; add `--verbose` to print excluded paths.

`ARTIFACTS_PUBLIC_BASE_URL` must be the actual Vercel production or preview host that serves this app. Published Artifacts are served by the Vercel rewrite from `/a/{opaque}` and nested `/a/{opaque}/{path}` URLs to the API functions with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` headers.
