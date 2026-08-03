# Deployment

## Vercel project

The Vercel project is set up under the `TheFocusAI` team:

- Project: `thefocusai/artifacts-thefocus-ai`
- Production alias: `https://artifacts-thefocus-ai.vercel.app`
- Custom domain: `https://artifacts.thefocus.ai`
- Git repository: `https://github.com/The-Focus-AI/artifacts.thefocus.ai`

The project was connected with:

```bash
vercel link --yes --scope thefocusai --project artifacts-thefocus-ai
vercel git connect https://github.com/The-Focus-AI/artifacts.thefocus.ai.git --scope thefocusai
```

Vercel should create Preview deployments for future pull requests from this GitHub repository after the Git connection is active.

## Domain setup

The custom domain has been added to the Vercel project:

```bash
vercel domains add artifacts.thefocus.ai --scope thefocusai
```

DNS is hosted in Cloudflare for `thefocus.ai`. The required Vercel A record is:

```text
A artifacts.thefocus.ai 76.76.21.21
```

The current Cloudflare record is intentionally DNS-only, not proxied:

```text
type: A
name: artifacts.thefocus.ai
content: 76.76.21.21
proxied: false
ttl: 300
```

Validate the domain with:

```bash
vercel domains inspect artifacts.thefocus.ai --scope thefocusai
vercel alias ls --scope thefocusai | grep artifacts.thefocus.ai
curl -I https://artifacts.thefocus.ai
```

## Environment variables

Production environment variables are configured in Vercel from fnox/1Password:

- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`

They are declared in `fnox.toml` and should never be committed as plaintext.

Production values can be set or refreshed with:

```bash
fnox exec -- sh -c '
  vercel env add DATABASE_URL production --sensitive --force --yes --value "$DATABASE_URL"
  vercel env add BLOB_READ_WRITE_TOKEN production --sensitive --force --yes --value "$BLOB_READ_WRITE_TOKEN"
'
```

Preview deployments need the same variables in the Vercel Preview environment before PR smoke tests can publish or serve real Artifacts. If the CLI prompts for a Git branch, leave it blank in an interactive shell to apply to all Preview branches, or configure the Preview variables in the Vercel dashboard.

Check configured variables with:

```bash
vercel env ls --scope thefocusai
```

## Production deploy

Production code deploys are triggered by GitHub/Vercel from `main`:

```bash
mise run lint
mise run test
mise run deploy
git push origin main
```

Do not run `vercel deploy` for code changes. Use direct Vercel CLI commands only for environment variable updates or one-time project configuration.

## Live smoke test

After deploying and confirming env vars are present, follow the full flow in [Smoke test](smoke-test.md). For a quick publish/view check:

```bash
echo '<!doctype html><h1>Smoke</h1>' > /tmp/artifact-smoke.html
pnpm run build
ARTIFACTS_PUBLIC_BASE_URL=https://artifacts.thefocus.ai \
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- node dist/src/cli.js publish /tmp/artifact-smoke.html
```

Then curl the returned Publication URL:

```bash
curl -i https://artifacts.thefocus.ai/a/{opaque}/
curl -I https://artifacts.thefocus.ai/a/{opaque}/
```

Expected response:

- HTTP `200`
- original HTML body
- `Cache-Control: no-store`
- `X-Robots-Tag: noindex, nofollow`
- `Content-Type: text/html; charset=utf-8`

## Preview deployment validation

For future PRs, Vercel should publish a Preview URL automatically once GitHub integration sees the pull request. Validate by checking the PR checks/status area or Vercel project deployments.

Once a Preview URL exists, use that URL as `ARTIFACTS_PUBLIC_BASE_URL` for a smoke publish:

```bash
ARTIFACTS_PUBLIC_BASE_URL=https://<preview-deployment>.vercel.app \
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
fnox exec -- node dist/src/cli.js publish /tmp/artifact-smoke.html
```
