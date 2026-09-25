# npm publish credentials

Covers two inbox items that were filed before npm changed its token rules:

- "Add the NPM_TOKEN secret to the jboho/safe-npm repo ..."
- "Generate the token at npmjs.com (Automation token, publish scope) ..."

Goal: let `.github/workflows/publish.yml` publish `@jboho/safe-pnpm` to the public npm registry on a `v*` tag push.

## Decision: trusted publishing, not NPM_TOKEN

The items asked for an npm Automation token stored as the `NPM_TOKEN` secret. That no longer works well:

- npm stopped creating classic (Automation) tokens on 2025-11-05 and revoked all of them on 2025-12-09.
- Granular write tokens expire in 90 days at most and need two-factor bypass for CI.

[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) replaces the stored token: npm accepts the workflow's GitHub OIDC identity and issues a short-lived credential per run. Nothing to store or rotate.

## Done so far

- PR #12: repo renamed `jboho/safe-npm` → `jboho/safe-pnpm`; README badge updated.
- PR #13 (merge `6cd320a`):
  - `publish.yml`: `id-token: write`; publish step on Node 24 with npm >= 11.5.1; `--provenance`; no `NODE_AUTH_TOKEN`.
  - `package.json`: `repository` set to `git+https://github.com/jboho/safe-pnpm.git` (npm checks it matches).
  - `CONTRIBUTING.md`: publishing steps corrected (npm registry, fires on tag push, trusted publisher dependency).

## Remaining

1. On npmjs.com → `@jboho/safe-pnpm` → Settings → Trusted Publisher, add GitHub Actions: user `jboho`, repo `safe-pnpm`, workflow `publish.yml`. Needs an account that can publish the `@jboho` scope.
2. Optional, after one successful trusted publish: in the same settings page, set publishing access to disallow tokens, so only the workflow can publish.
3. Next release: bump `package.json` version, merge, push tag `vX.Y.Z`. Confirm the run succeeds and the npm page shows provenance.

## Done when

- A tag-triggered `publish.yml` run publishes a new version with no `NPM_TOKEN` secret on the repo.
- Both inbox items are checked off.
