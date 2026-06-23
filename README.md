# @jboho/safe-pnpm

[![CI](https://github.com/jboho/safe-npm/actions/workflows/ci.yml/badge.svg)](https://github.com/jboho/safe-npm/actions/workflows/ci.yml)
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
3. **Run in Docker** — ephemeral container, `--cap-drop ALL`, no home directory or credential access.
4. **Copy results back** — `node_modules` and the updated lockfile land in your project. The container is discarded.

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

Registry tokens are **not** forwarded into the sandbox by default — a malicious
install lifecycle script running in the container could otherwise read and
exfiltrate them. To enable forwarding for private installs, opt in:

```sh
SAFE_PNPM_FORWARD_TOKENS=1 pnpm install
```

When set, `NODE_AUTH_TOKEN` and `NPM_TOKEN` are passed into the container if
present in your environment. Prefer read-only, registry-scoped tokens.

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
- [Performance — overhead numbers and when they matter](./docs/performance.md)
- [Socket.dev behavioral scanning setup](./docs/socket.md)
- [Contributing](./CONTRIBUTING.md)
