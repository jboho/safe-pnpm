# Contributing

## Development Setup

```sh
git clone https://github.com/jboho/safe-pnpm
cd safe-pnpm
npm install
```

No build step — this is plain Node.js CommonJS. The CLI entry point is `bin/safe-pnpm.js`.

## Running Tests

```sh
npm test
```

Tests use Node.js's built-in `node:test` runner (no external test framework). Test files live in `test/` and follow the `*.test.js` naming convention.

Coverage falls into three groups:

- **Utility modules** (`lib/util/`) — plain unit tests: `colors.test.js`, `shell.test.js`, `versions.test.js`.
- **Shell library** (`assets/_safe_pkg_shared.sh`) — the wrapper logic that runs on end-user machines, driven through bash: `socket.test.js`, `two-phase.test.js`, `wrappers.test.js`.
- **Socket classifier** (`assets/socket-classify.js`) — the Node script that maps a Socket scan result onto pass / findings / failure: `socket-classify.test.js`.

The command modules (`lib/commands/`) are not unit tested — they depend on Docker, an interactive TTY, and the filesystem at `~/.safe-pnpm/`, making them better suited to manual integration testing.

### The Socket test suite

The Socket layer is covered end to end without any Docker, network, or real Socket account, using two stubbing patterns:

- **`test/socket.test.js`** exercises the shell library. Its `runShared` helper points `$HOME` at a throwaway temp directory, drops a stub `socket` binary and the real `socket-classify.js` into `~/.safe-pnpm/`, then sources `_safe_pkg_shared.sh` and runs a snippet. The stub records the arguments it was called with and emits whatever JSON and exit code the test supplies, so each scan outcome — healthy, findings, API error, unconfigured, not installed — is reproducible. Tests run without a TTY, i.e. the non-interactive path (warn-and-continue by default, block under `SAFE_PNPM_SOCKET_STRICT=1`).
- **`test/socket-classify.test.js`** exercises the classifier directly. Its `classify` helper writes a JSON body to a temp file and runs `socket-classify.js <file> <socket-exit-code>`, asserting on the process exit code and the one-line reason on stderr.

The classifier's exit codes are the contract between the two: `0` pass, `3` findings, `4` failed (see the header of `assets/socket-classify.js`).

To add a new Socket case:

1. If it's about how a raw scan result is interpreted (a new envelope shape, a new exit code), add it to `socket-classify.test.js` — write the JSON body and expected exit code/reason.
2. If it's about how the wrapper reacts to that outcome (warning text, strict-mode blocking, whether the scan ran at all), add it to `socket.test.js` using `runShared` with the matching `socketStdout` / `socketExit` / `installSocket` options.

## Linting and Formatting

```sh
npm run lint      # oxlint + Biome lint
npm run format    # Biome format (write)
npm run check     # Biome check (format + lint, write)
```

Biome handles formatting and a broad lint rule set. oxlint handles additional rules that Biome doesn't cover. Both run in CI.

## Project Structure

```
bin/
  safe-pnpm.js          CLI entry point
lib/
  commands/
    setup.js            safe-pnpm setup
    update.js           safe-pnpm update
    doctor.js           safe-pnpm doctor
  util/
    colors.js           ANSI helpers (no deps)
    docker.js           Docker interactions
    shell.js            Shell detection and rc file wiring
    versions.js         Prerequisite version checks
assets/
  Dockerfile            Docker image definition
  entrypoint.sh         Sets NODE_EXTRA_CA_CERTS at container runtime
  _safe_pkg_shared.sh   Shared prescan/dispatch/run logic sourced by the wrappers
  pnpm-wrapper.sh       pnpm shell function — bash/zsh (also npm-, yarn-)
  pnpm-wrapper.fish     pnpm shell function — fish (also npm-, yarn-)
  pnpm-wrapper.ps1      pnpm shell function — PowerShell (also npm-, yarn-)
  scan-shai-hulud.js    Shai Hulud 2 supply chain scanner (bundled)
  socket-classify.js    Classifies `socket scan` output into pass / findings / failure
docs/
  security.md           Threat model
  performance.md        Overhead numbers and tradeoffs
  socket.md             Socket.dev setup and tiers
  private-registry.md   Token-safe private/scoped installs
test/
  colors|shell|versions.test.js   Unit tests for lib/util/
  socket|two-phase|wrappers.test.js   Shell library (assets/_safe_pkg_shared.sh)
  socket-classify.test.js         Socket result classifier (assets/socket-classify.js)
```

## Making Changes to the Wrapper

`assets/pnpm-wrapper.sh` (and `.fish`, `.ps1`) is what end users actually run on their machines. When you change these files:

1. Test locally by sourcing the updated wrapper: `. ./assets/pnpm-wrapper.sh`
2. Run `safe-pnpm update` to sync changes to `~/.safe-pnpm/` on your dev machine
3. Verify with `pnpm --version` (pass-through) and `pnpm install` in a test project (Docker path)

The opt-in Socket layer shells out to `assets/socket-classify.js` with the host `node`, so that path is a runtime dependency of the wrapper (not just the Docker image) — keep the classifier free of build steps and non-stdlib deps, and assume only `node` on `PATH`. See [docs/socket.md](./docs/socket.md).

## Submitting Changes

1. Branch from `main` using `chore/TICKET-description` or `feat/TICKET-description`
2. Run `npm test && npm run check` before pushing
3. Open a PR — the publish workflow fires on a `v*` tag push, not on merge

## Publishing a New Version

1. Bump the version in `package.json`
2. Merge to `main`
3. Create a GitHub Release tagged `vX.Y.Z` (the tag must match `package.json`'s version, or the workflow fails)
4. The `.github/workflows/publish.yml` workflow publishes `@jboho/safe-pnpm` to the public npm registry

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): npm accepts the workflow's GitHub identity, so there is no `NPM_TOKEN` secret. It depends on a trusted publisher entry on npmjs.com (package settings → Trusted Publisher: user `jboho`, repo `safe-pnpm`, workflow `publish.yml`). Renaming the repo or the workflow file breaks publishing until that entry is updated.
