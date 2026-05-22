# Release readiness

## npm package

The CLI is distributed as `@the-focus-ai/artifacts` and exposes the `artifacts` binary.

Before publishing a release candidate:

```bash
mise run lint
mise run test
mise run deploy
pnpm pack --dry-run
```

Review the `pnpm pack --dry-run` file list. It should contain the built `dist/src` CLI modules and README/license metadata only; it should not include `.fnox`, `.vercel`, tests, reports, local state, or source-only files.

Preferred publishing is the `Publish npm package` GitHub Actions workflow using npm Trusted Publishing with OIDC/provenance rather than committing or storing a long-lived npm token. Before the first workflow publish, configure npm so package `@the-focus-ai/artifacts` trusts this repository/workflow (`.github/workflows/npm-publish.yml`) and make sure the GitHub `npm` environment has the intended reviewers.

To publish through GitHub, update `package.json` to the intended version, merge that commit to `main`, then push a matching `vX.Y.Z` tag. The workflow refuses to publish if the pushed tag does not match `package.json` exactly:

```bash
git checkout main
git pull --ff-only
git tag v1.0.0
git push origin v1.0.0
```

If Trusted Publishing is not configured yet, a human maintainer with npm publish rights can publish from a clean checkout with a short-lived or granular npm token:

```bash
npm publish --access public
```

Do not pass `--provenance` for a local publish. npm automatic provenance generation only works from supported CI providers such as GitHub Actions; local shells fail with `Automatic provenance generation not supported for provider: null`. If a manual token is ever needed, keep it in 1Password/fnox or npm's local auth store; never commit it.

After publishing, verify `npx` resolves the package and prints CLI usage:

```bash
npx @the-focus-ai/artifacts --help
npx @the-focus-ai/artifacts whoami
```

`whoami` should either print the active Publisher email when configured or fail with `Not logged in`; either result confirms the executable starts correctly.

## Code deployment

Code changes deploy through the GitHub-to-Vercel integration. Merge to `main` and `git push` rather than running `vercel deploy` directly for application code.

Use direct Vercel CLI commands only for project setup or environment variable changes, as described in [Deployment](deploy.md).

## Final release smoke

After a Preview or Production deployment has the required environment variables, run the live smoke in [Smoke test](smoke-test.md). Record any checks that cannot be run locally in the PR notes, especially real Clerk browser login and real Vercel/Neon/Blob-backed publish/remove flows.
