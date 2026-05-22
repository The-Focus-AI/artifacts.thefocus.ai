# npm/npx Release Readiness Research

## Abstract

This report summarizes current npm package publishing guidance relevant to releasing the Artifacts CLI as `@thefocus/artifacts` for `npx @thefocus/artifacts ...` usage. The safest implementation path is to make the package metadata match the ADR, constrain the packed tarball with an explicit `files` allowlist, build before packing/publishing, and document a repeatable publish path. Longer term, npm Trusted Publishing with OIDC and provenance is preferred over long-lived npm tokens.

## Findings

### Package identity and entry points

The npm package must have stable `name` and `version` fields; npm treats that pair as the unique published artifact identifier. The project ADR says the CLI should be distributed as `@thefocus/artifacts`, so `package.json` should use that package name rather than the deployment host name.

For CLI use, npm supports a `bin` map. The existing `artifacts` executable is appropriate for `npx @thefocus/artifacts publish ...` as long as the built target is included in the package and starts with a Node shebang.

### Tarball contents

npm includes broad defaults when `files` is omitted. Official npm package metadata docs describe `files` as an allowlist of entries included in the packed package. For this repo, an explicit `files` list should include `dist`, `README.md`, `LICENSE` if added later, and any required public metadata while excluding source tests, reports, local config, `.fnox`, and deployment-only files.

### Build lifecycle

Because the CLI points to `dist/src/cli.js`, the publish path must run `pnpm run build` before `npm pack` or `npm publish`. A `prepack` script is a reliable local guard because it runs before `npm pack` and publish packing. Keeping `test` and `lint` separate avoids surprising users who install from git, while the release runbook can require them before packing.

### Security and provenance

npm Trusted Publishing allows CI/CD workflows to publish with OIDC instead of long-lived npm tokens. GitHub’s changelog notes npm Trusted Publishing with OIDC is generally available and removes the need to manage long-lived tokens. npm provenance support can cryptographically link a package to its source commit. If publishing manually before trusted publishing is configured, use a short-lived/granular npm token and publish from a clean tree after `npm pack --dry-run` inspection.

## Recommendations for this issue

1. Rename the package to `@thefocus/artifacts` to satisfy ADR 0003 and enable `npx @thefocus/artifacts`.
2. Add package metadata needed for publication: description, repository, homepage, bugs, engines, publishConfig, and explicit `files`.
3. Add a `prepack` script that builds the TypeScript output before packing.
4. Add package metadata tests so regressions are caught before release.
5. Update README/docs with exact verification and release steps, including `pnpm pack --dry-run`/`npm pack --dry-run` and a manual publish fallback.
6. Prefer a future GitHub Actions Trusted Publishing workflow once npm package trust is configured.

## References

- npm Docs: `npm publish` — https://docs.npmjs.com/cli/v10/commands/npm-publish/
- npm Docs: `package.json` fields and `files` — https://docs.npmjs.com/cli/v10/configuring-npm/package-json/
- npm Docs: trusted publishers / `npm trust` — https://docs.npmjs.com/cli/v11/commands/npm-trust/
- GitHub Changelog: npm trusted publishing with OIDC generally available — https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- npm provenance project README — https://github.com/npm/provenance
