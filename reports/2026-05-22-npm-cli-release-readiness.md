# npm CLI release readiness report

## Abstract

This report records the release-readiness checks for distributing the Artifacts CLI through npm as `@thefocus/artifacts` with an `artifacts` executable. The low-risk path is to publish only built CLI artifacts and documentation, use the existing pnpm/mise toolchain for repeatable builds, and prefer npm Trusted Publishing from GitHub Actions once the package is ready for automation.

## Findings

### Package identity and publish surface

The npm package needs a stable `name` and `version`; for this repo the PRD-selected package name is `@thefocus/artifacts`. The `bin` map should keep exposing `artifacts` so both `npx @thefocus/artifacts ...` and installed shell commands resolve to the built CLI entry point.

The package should publish a narrow file set, not the whole Vercel app checkout. A `files` allowlist for `dist/src` and README content keeps local config, reports, tests, Vercel project files, and repository-only assets out of the tarball. `pnpm pack --dry-run` is the release verification command that shows the actual tarball contents before publishing.

### Build lifecycle

The CLI entry point is TypeScript and must be built before publish. A `prepack` script that runs the existing build is safer than relying on a human to remember `pnpm run build`; npm and pnpm both run lifecycle scripts during packing/publishing.

### Authentication and provenance

npm Trusted Publishing uses CI OIDC instead of long-lived npm automation tokens. This is the preferred future automation path for GitHub Actions because it reduces secret sprawl and can attach provenance. Until that workflow exists, use an interactive owner publish from a clean working tree and avoid committing npm tokens.

## Recommended verification

- `mise run lint`
- `mise run test`
- `mise run deploy` or `pnpm run build`
- `pnpm pack --dry-run`
- For a real release: `npm publish --access public --provenance` from the produced package once npm ownership and 2FA/provenance requirements are satisfied.

## References

1. npm Docs — Trusted publishing for npm packages: https://docs.npmjs.com/trusted-publishers/
2. npm Docs — package.json fields: https://docs.npmjs.org/cli/v11/configuring-npm/package-json
3. npm Docs — npm publish command: https://docs.npmjs.com/cli/v10/commands/npm-publish/
4. npm Docs — scripts lifecycle: https://docs.npmjs.org/cli/v11/using-npm/scripts
