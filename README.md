# @jboho/safe-pnpm

[![CI](https://github.com/jboho/safe-pnpm/actions/workflows/ci.yml/badge.svg)](https://github.com/jboho/safe-pnpm/actions/workflows/ci.yml)
[![Node >=16](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

A Docker-based install isolation wrapper for **pnpm, npm, and yarn** that protects developer machines from malicious package lifecycle scripts (`postinstall`, `preinstall`, etc.).

When you run `pnpm install`, `npm install`, or `yarn install`, the wrapper pre-scans for known CVEs and malicious packages, runs the install inside an ephemeral Docker container that only sees your manifests and lockfile (never source files, `.env`, or credentials), then copies `node_modules` back. All non-install commands pass through instantly with no overhead.

## Install

```sh
npm install -g @jboho/safe-pnpm
safe-pnpm setup
```

Requires: Docker Desktop 4.0+, Node.js 16+, and at least one of: pnpm 7.0+, npm 7.0+, yarn 1.x.

The package is named `safe-pnpm` for historical reasons. npm and yarn are first-class — `setup` detects which managers you have installed and lets you choose which ones to wrap.

---

## Commands

### `safe-pnpm setup`

Interactive first-time installation. Checks prerequisites, builds the `safe-pnpm:latest` Docker image, and wires shell functions for each manager you enable.

```sh
safe-pnpm setup
# Detected package managers:
#   Enable pnpm   (10.33.0)  [Y/n]
#   Enable npm    (10.2.4)   [Y/n]
#   Enable yarn   (1.22.22)  [Y/n]

source ~/.zshrc    # or open a new terminal
```

### `safe-pnpm update`

Refresh wrapper files and rebuild the Docker image after a package update. If `update` detects a manager that wasn't enabled before, it offers to add it:

```sh
npm update -g @jboho/safe-pnpm
safe-pnpm update
```

### `safe-pnpm doctor`

Check that everything is installed and configured correctly:

```
  ✓  Docker           running
  ✓  Image            safe-pnpm:latest present
  ✓  Installation     ~/.safe-pnpm/ present
  ✓  Wrapper files    all 9 files present
  ✓  Shell config     source line found in ~/.zshrc
  ✓  pnpm             10.33.0
  ✓  npm              10.2.4
  ✓  Node.js          v22.0.0
  ✓  CA cert          not configured (no TLS proxy)
```

---

## How It Works

When you run an install-class command:

| Manager | Intercepted subcommands |
|---|---|
| pnpm | `install`, `add`, `update`, `ci`, `remove`, `fetch` |
| npm | `install`, `i`, `ci`, `update`, `uninstall`, `un` |
| yarn | `install`, `add`, `remove`, `upgrade` (yarn v1 only) |

1. **Pre-install scan** — manager-native audit (`pnpm audit`, `npm audit`, `yarn audit`), Shai Hulud 2 malicious package check, and [Socket behavioral analysis](./docs/socket.md) if configured.
2. **Copy only manifests** — `package.json`, the lockfile, workspace files, and `.npmrc` / `.yarnrc` go into a temp directory. Source files, `.env`, and secrets never leave the host.
3. **Fetch in Docker** — ephemeral container, `--cap-drop ALL`, `--ignore-scripts`. Dependencies download with any registry token available but no package code running.
4. **Build in Docker** — a second container with `--network none` and the token removed runs any lifecycle/build scripts against the downloaded store — nothing to steal, nowhere to send it. See [the two-phase model](./docs/security.md#two-phase-install).
5. **Copy results back** — `node_modules` lands in your project; the lockfile and manifests come from a snapshot taken before any build script ran. The containers are discarded.

---

## Socket.dev Scanning

[Socket](https://socket.dev) adds a third pre-install layer — behavioral analysis of package lifecycle scripts (suspicious network calls, obfuscation, typosquatting) — alongside the always-on CVE audit and Shai Hulud supply-chain scan. It is **opt-in**: authenticate once with `socket login`, then enable it per-command or per-session.

```sh
pnpm install --socket              # this invocation only
npm install --socket
yarn add lodash --socket

export SAFE_PNPM_ENABLE_SOCKET=1   # every install-class command this session
```

Put `--socket` *after* the subcommand (`pnpm install --socket`, not `pnpm --socket install`) — safe-pnpm consumes the flag before the args reach the package manager.

A scan that finds bad packages prompts (interactive) or warns and continues (non-interactive); a scan that *couldn't run* — no token, offline, quota exhausted — only warns, so an expired token never silently blocks you. In CI, set `SAFE_PNPM_SOCKET_STRICT=1` to turn both findings and scan failures into hard blocks; without it a pipeline whose Socket token has expired stays green while doing no behavioral scanning at all.

What each outcome looks like on the console (the scan runs before the Docker install):

```
→ Socket behavioral scan...
# healthy    — nothing else printed; the install proceeds
# findings   — ⚠️  Socket reported policy violations for this dependency set. Continuing in non-interactive mode.
# scan failed — ⚠️  Socket scan could not run: 401 Unauthorized. Continuing without Socket results.
# under SAFE_PNPM_SOCKET_STRICT=1, either warning becomes:
#             ✗ ... Blocking (SAFE_PNPM_SOCKET_STRICT=1).
```

```sh
export SAFE_PNPM_SOCKET_STRICT=1   # CI: block on findings AND on scan failure
```

> The Socket layer shells out to a bundled Node classifier, so **`node` must be on `PATH` at install time** for it to run (the base install already requires Node.js 16+). If `node` is missing the layer is treated as a failure — warned by default, blocked under strict mode.

See [docs/socket.md](./docs/socket.md) for the full outcome table, failure semantics, and account tiers.

---

## Bypass

To bypass the wrapper and run the native binary directly:

```sh
\pnpm install         # bash/zsh
\npm install
\yarn install

command pnpm install  # any POSIX shell (also fish)
command npm install
command yarn install

pnpm.cmd install      # PowerShell
npm.cmd install
yarn.cmd install
```

---

## Private Registries

Private and scoped registries work out of the box. Configure your registry the
usual way — `.npmrc` (including `${NPM_TOKEN}` interpolation) or a `NODE_AUTH_TOKEN`
/ `NPM_TOKEN` environment variable — and install normally:

```sh
export NPM_TOKEN=your-read-only-token
pnpm install
```

The token is available only during the script-free **fetch** phase and is
withheld (along with any `.npmrc` credential lines) during the **build** phase,
so untrusted lifecycle scripts never see it. The old `SAFE_PNPM_FORWARD_TOKENS`
opt-in is obsolete. See [private-registry.md](./docs/private-registry.md).

If a package's build step genuinely needs network (e.g. `esbuild`, `sharp`), set
`SAFE_PNPM_BUILD_NETWORK=1`; the token is still withheld.

---

## Docker Not Running

When Docker is unavailable, the wrapper fails **closed** rather than silently
running the native package manager (which would execute untrusted lifecycle
scripts on the host):

- **Interactive shell** — you are prompted before any native fallback.
- **Non-interactive (CI, scripts)** — the install is refused. To allow a native
  fallback in this case, set `SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1`.

---

## Shell Support

| Shell | Config modified |
|---|---|
| zsh | `~/.zshrc` |
| bash (macOS) | `~/.bash_profile` |
| bash (Linux) | `~/.bashrc` |
| fish | `~/.config/fish/functions/{pnpm,npm,yarn}.fish` (one per enabled manager) |
| PowerShell | `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` |

---

## Further Reading

- [Security model — what's protected and what isn't](./docs/security.md)
- [Private registries — token-safe private/scoped installs](./docs/private-registry.md)
- [ADR 0001 — two-phase install design and findings](./docs/decisions/0001-two-phase-private-registry.md)
- [Performance — overhead numbers and when they matter](./docs/performance.md)
- [Socket.dev behavioral scanning setup](./docs/socket.md)
- [Contributing](./CONTRIBUTING.md)
