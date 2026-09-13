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

Tests cover the utility modules in `lib/util/`. The command modules (`lib/commands/`) are not unit tested — they depend on Docker, an interactive TTY, and the filesystem at `~/.safe-pnpm/`, making them better suited to manual integration testing.

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
  pnpm-wrapper.sh       pnpm shell function — bash/zsh
  pnpm-wrapper.fish     pnpm shell function — fish
  pnpm-wrapper.ps1      pnpm shell function — PowerShell
  scan-shai-hulud.js    Shai Hulud 2 supply chain scanner (bundled)
  socket-classify.js    Classifies `socket scan` output into pass / findings / failure
docs/
  security.md           Threat model
  performance.md        Overhead numbers and tradeoffs
  socket.md             Socket.dev setup and tiers
test/
  *.test.js             Unit tests for lib/util/
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
3. Open a PR — the publish workflow fires on release creation, not on merge

## Publishing a New Version

1. Bump the version in `package.json`
2. Merge to `main`
3. Create a GitHub Release tagged `vX.Y.Z`
4. The `.github/workflows/publish.yml` workflow publishes to GitHub Packages automatically
