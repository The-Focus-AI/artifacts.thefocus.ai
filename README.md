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

## Single-file publishing

The first tracer-bullet publishing path accepts one local HTML file and returns a canonical unlisted Publication URL:

```bash
ARTIFACTS_PUBLIC_BASE_URL=https://your-vercel-host.example \
ARTIFACTS_PUBLISHER_EMAIL=you@thefocus.ai \
fnox exec -- pnpm artifacts publish ./artifact.html
```

`ARTIFACTS_PUBLIC_BASE_URL` must be the actual Vercel production or preview host that serves this app. Published single-file Artifacts are served by the Vercel rewrite from `/a/{opaque}` to the API function at `/api/a/{opaque}` with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` headers.
