# End-to-end smoke test

This smoke verifies the integrated v1 flow: login, publish, view, hotfix during the Revision Window, list, remove, and 404 after Removal.

## Automated local smoke

The fake-adapter smoke runs without secrets:

```bash
pnpm run test -- tests/e2e-smoke.test.ts
```

It issues a test Publisher Token, publishes a directory Artifact, serves the Publication, republishes within the Revision Window, lists the Publisher's Publications, removes the Publication, and verifies that the Publication URL returns 404.

## Live Preview or Production smoke

Prerequisites:

- Vercel deployment has `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, and Clerk login environment configured.
- The Clerk redirect URL includes the deployment's `/login` URL.
- You have access to a verified `@thefocus.ai` email.

```bash
BASE_URL=https://artifacts.thefocus.ai # or a Vercel Preview URL
SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/index.html" <<'HTML'
<!doctype html><h1>Artifacts smoke v1</h1>
HTML

ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts login --base-url "$BASE_URL"
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts whoami
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts publish "$SMOKE_DIR" --title "Smoke Test"
```

Copy the printed Publication URL as `PUBLICATION_URL`, then verify viewing headers and body:

```bash
curl -i "$PUBLICATION_URL"
```

Expected:

- HTTP `200`
- body contains `Artifacts smoke v1`
- `Cache-Control: no-store`
- `X-Robots-Tag: noindex, nofollow`

Hotfix within 15 minutes:

```bash
cat > "$SMOKE_DIR/index.html" <<'HTML'
<!doctype html><h1>Artifacts smoke hotfix</h1>
HTML
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts publish "$SMOKE_DIR" --title "Smoke Test Hotfix"
curl -i "$PUBLICATION_URL"
```

Expected: the same Publication URL now serves `Artifacts smoke hotfix`.

List and remove:

```bash
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts list
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts remove "$PUBLICATION_URL" --yes
curl -i "$PUBLICATION_URL"
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts logout
```

Expected:

- `list` includes the active Publication URL and title before Removal.
- `remove --yes` prints `Removed ...`.
- The final curl returns HTTP `404`.
- `logout` removes local Publisher Token state.

## Non-interactive token smoke

For CI or constrained terminals, inject a Publisher Token instead of the browser flow:

```bash
THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_... \
ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" \
pnpm artifacts publish "$SMOKE_DIR"
```
