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

## Living Doc smoke

### Local playground (no secrets)

`scripts/living-doc-dev.ts` serves the real review editor, view page, and
agent/review APIs against in-memory stores — no `DATABASE_URL` or Blob token.

```bash
pnpm exec tsx scripts/living-doc-dev.ts
```

It seeds a sample Living Doc and prints a Review URL, a View URL, and a
Publisher Token. Open the Review URL in a browser to edit and comment, then
drive the agent side from another terminal with the printed token:

```bash
export THEFOCUS_ARTIFACTS_TOKEN=<printed token>
export ARTIFACTS_PUBLIC_BASE_URL=http://localhost:4100
pnpm artifacts doc pull <View URL>
echo '{"suggestions":[{"anchorQuote":"...","replacement":"..."}]}' \
  | pnpm artifacts doc respond <View URL>
```

Accept or reject the suggestion back in the browser. State resets on restart.

### Live Preview or Production smoke

Prerequisites: the deployment has `DATABASE_URL` configured and
`migrations/0005_create_living_docs.sql` has been applied to that database.

```bash
BASE_URL=https://artifacts.thefocus.ai # or a Vercel Preview URL
DOC=$(mktemp -d)/doc.md
printf '# Living Doc smoke\n\nFirst draft.\n' > "$DOC"

ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts doc publish "$DOC" --title "Doc Smoke"
```

The JSON output includes `viewUrl` and `reviewUrl`. Then:

1. `curl -i "<viewUrl>"` — expect HTTP `200`, `Cache-Control: no-store`,
   `X-Robots-Tag: noindex, nofollow`, and an HTML page rendering the Markdown.
2. Open `<reviewUrl>` in a browser — the editor loads the Markdown. Edit some
   text (status flips to `Saved`), select a phrase, write a comment, and press
   "Comment on selection".
3. Pull as the agent: `ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts doc pull "<viewUrl>"`
   — expect `versionNumber: 1`, your edited Markdown, and the comment under
   `openComments`.
4. Respond: `echo '{"suggestions":[{"anchorQuote":"<exact text from the doc>","replacement":"<new text>"}]}' | ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts doc respond "<viewUrl>"`.
5. Reload the Review URL — the suggestion card appears; Accept applies it to
   the editor text, and the View URL reflects the change.
6. Pull again — expect `versionNumber: 2` and `diffFromPreviousVersion`
   showing the round's changes.
7. Clean up: `ARTIFACTS_PUBLIC_BASE_URL="$BASE_URL" pnpm artifacts doc remove "<viewUrl>" --yes`,
   then `curl -i "<viewUrl>"` returns HTTP `404` and the Review URL editor
   shows "Could not load".
