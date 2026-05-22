# Release readiness

## npm package

The CLI is distributed as `@thefocus/artifacts` and exposes the `artifacts` binary.

Before publishing a release candidate:

```bash
mise run lint
mise run test
mise run deploy
pnpm pack --dry-run
```

Review the `pnpm pack --dry-run` file list. It should contain the built `dist/src` CLI modules and README/license metadata only; it should not include `.fnox`, `.vercel`, tests, reports, local state, or source-only files.

Publish only from a clean working tree after the version has been intentionally bumped:

```bash
npm publish --access public --provenance
```

Preferred future automation is npm Trusted Publishing from GitHub Actions using OIDC/provenance rather than committing or storing a long-lived npm token. If a manual token is ever needed, keep it in 1Password/fnox or npm's local auth store; never commit it.

## Code deployment

Code changes deploy through the GitHub-to-Vercel integration. Merge to `main` and `git push` rather than running `vercel deploy` directly for application code.

Use direct Vercel CLI commands only for project setup or environment variable changes, as described in [Deployment](deploy.md).

## Final release smoke

After a Preview or Production deployment has the required environment variables, run the live smoke in [Smoke test](smoke-test.md). Record any checks that cannot be run locally in the PR notes, especially real Clerk browser login and real Vercel/Neon/Blob-backed publish/remove flows.
