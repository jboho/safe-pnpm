# ADR 0001 — Two-phase install for private registries

Status: accepted (2026-08-22)

## Problem

Installing private packages needs a registry token. The wrapper already copied
a project `.npmrc` into the sandbox unconditionally and (behind
`SAFE_PNPM_FORWARD_TOKENS=1`) forwarded `NODE_AUTH_TOKEN`/`NPM_TOKEN`. But the
same container also executed untrusted lifecycle scripts with network access —
so any `.npmrc` credential or forwarded token was readable and exfiltratable by
a malicious `postinstall`. The token safety and the private-registry use case
were in direct conflict.

## Decision

Split every install into two containers that never hold the token and untrusted
code at the same time:

- **Phase 1 — fetch.** Network on, token available, `--ignore-scripts`. Resolves
  and downloads every dependency into a store under `/app`. No package code runs,
  so the token cannot leak.
- **Phase 2 — build.** `--network none` (default), token withheld, `.npmrc`
  credential lines stripped. Lifecycle/build scripts run against the
  already-populated store with nothing left to steal.

Escape hatch: `SAFE_PNPM_BUILD_NETWORK=1` keeps network in phase 2 for packages
whose build genuinely needs it (esbuild, sharp, playwright); the token is still
withheld.

This closes the `.npmrc`-smuggling hole for the non-private case too — a strict
improvement — and makes `SAFE_PNPM_FORWARD_TOKENS` unnecessary (tokens are now
safe by default in the fetch phase).

## Per-manager commands (empirically verified against `safe-pnpm:latest`)

| Manager | Phase 1 (network + token)        | Phase 2 (`--network none`, no token)            | Store under /app                  |
|---------|----------------------------------|-------------------------------------------------|-----------------------------------|
| npm     | `npm … --ignore-scripts`         | `npm rebuild`                                    | `--cache /app/.safe-store`        |
| yarn    | `yarn … --ignore-scripts`        | `yarn install --offline --force`                | `--cache-folder /app/.safe-store` |
| pnpm    | `pnpm … --ignore-scripts`        | `pnpm install --offline --trust-lockfile`       | `--config.store-dir=/app/.safe-store` |

The store/cache must live under the shared `/app` volume so phase 2 resolves with
no network.

## Findings that shaped this (probed, not assumed)

- `--ignore-scripts` reliably suppresses lifecycle scripts in phase 1 for all
  three managers (verified: marker script did not run).
- **pnpm 11** runs a *"Verifying lockfile against supply-chain policies"* step
  that calls `registry.npmjs.org` even under `--offline`; with `--network none`
  it hangs on retries. `--trust-lockfile` skips it — safe in phase 2 because
  phase 1 already resolved with network.
- **pnpm 11** blocks *dependency* build scripts by default (`approve-builds`
  allowlist) and no longer reads the `pnpm` field in `package.json`. So for pnpm,
  dependency lifecycle scripts do not run in the sandbox at all unless the user
  has approved them — two-phase does not regress this; it only adds token safety.
- `pnpm rebuild` does **not** re-run deferred builds after an `--ignore-scripts`
  install in this image; the working phase-2 trigger is `install --offline
  --trust-lockfile` (reconstructs `node_modules` from the store).
- **yarn** classic has no `rebuild`; `yarn install --offline` alone will not
  re-run deferred scripts, but `yarn install --offline --force` does.
- **npm** `npm rebuild` runs dependency install/postinstall scripts offline —
  the cleanest phase-2 of the three.

## Consequences

- Two container invocations per install instead of one (phase 2 is offline and
  fast). Acceptable for a security tool.
- `.npmrc` credential lines are stripped between phases; non-auth config
  (registry URLs, scopes, `node-linker`, hoisting) is preserved.
- Builds that fetch at build time break under the default `--network none`; users
  set `SAFE_PNPM_BUILD_NETWORK=1` for those.
