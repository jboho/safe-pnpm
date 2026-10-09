<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">safe-pnpm</h1>

<p align="center">
  <strong>Docker install isolation for pnpm, npm and yarn — lifecycle scripts never run on your host</strong>
</p>

<p align="center">
  <a href="https://github.com/jboho/safe-pnpm/actions/workflows/ci.yml"><img src="https://github.com/jboho/safe-pnpm/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://www.npmjs.com/package/@jboho/safe-pnpm"><img src="https://img.shields.io/npm/v/@jboho/safe-pnpm.svg" alt="npm version" /></a>
  <a href="https://calver.org/"><img src="https://img.shields.io/badge/calver-YYYY.M.MICRO-228bff.svg" alt="CalVer" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg" alt="Node >=16" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <sub>pnpm · npm · yarn · two-phase Docker install · OSV malware scan · optional Socket scan</sub>
</p>

---

## Overview

**safe-pnpm** wraps **pnpm, npm, and yarn** so that package lifecycle scripts (`postinstall`, `preinstall`, etc.) never run on your machine.

When you run `pnpm install`, `npm install`, or `yarn install`, the wrapper pre-scans for known CVEs and malicious packages, runs the install inside an ephemeral Docker container that only sees your manifests and lockfile (never source files, `.env`, or credentials), then copies `node_modules` back. All non-install commands pass through instantly with no overhead.

| Topic               | Links                                                              |
| ------------------- | ------------------------------------------------------------------ |
| **License**         | [MIT](LICENSE)                                                     |
| **Security model**  | [docs/security.md](docs/security.md) · [SECURITY.md](SECURITY.md)  |
| **Contributing**    | [CONTRIBUTING.md](CONTRIBUTING.md)                                 |
| **Roadmap**         | [ROADMAP.md](ROADMAP.md)                                           |
| **Socket scanning** | [docs/socket.md](docs/socket.md)                                   |
| **Private registries** | [docs/private-registry.md](docs/private-registry.md)            |
| **Performance**     | [docs/performance.md](docs/performance.md)                         |
| **Versioning**      | [CalVer](https://calver.org/) `YYYY.M.MICRO`                       |

## Status

Published to npm as `@jboho/safe-pnpm` (first public release 2026.10.2, with provenance). Known gaps, tracked in [ROADMAP.md](ROADMAP.md) under M4:

- On Windows the PowerShell wrappers still run the containers as root inside Docker (`--cap-drop ALL` and `no-new-privileges` apply). macOS and Linux run them as your user.
- Rootless Docker and Podman are detected from `docker info`, and there the containers keep their default user, which is your own user on the host. This is not tested against a real rootless daemon.
- Unless your uid is 1000 (the image's `node` user), it has no user name inside the image, so a build script that looks up the current user (`whoami`, `os.userInfo()`) gets an error.
- The CVE audit runs on the host after the fetch, on a throwaway copy of the resolved manifests and lockfile plus your registry config. It does not run in your project directory, and pnpm skips `.pnpmfile.cjs` for it. A `yarn-path` line in `.yarnrc` is dropped for the audit.
- PowerShell is the least-tested shell: the wrappers and copy-back are tested on Linux pwsh only.
- Requires Docker; developed and tested on macOS and Linux CI. Windows is not tested.

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
command npm update -g @jboho/safe-pnpm
safe-pnpm update
```

Use `command npm` here. The wrappers refuse `-g` and `--global` installs, because the sandbox would install into a container that is thrown away and change nothing on your machine. Add `command` in front (`command npm install -g PKG`) to run a global install natively, without the safety checks.

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

1. **Pre-install scan** — [Socket behavioral analysis](./docs/socket.md) if configured.
2. **Copy only manifests** — `package.json`, the lockfile, workspace files, and `.npmrc` / `.yarnrc` go into a temp directory. Source files, `.env`, and secrets never leave the host.
3. **Fetch in Docker** — ephemeral container running as your user, `--cap-drop ALL`, `--ignore-scripts`. Dependencies download with any registry token available but no package code running.
4. **Malware check** — every version the fetch resolved, including packages being added, is checked against [OSV](https://osv.dev)'s malicious-package advisories. A hit stops the install before any package code runs. If OSV can't be reached the install warns and continues; `export SAFE_PNPM_OSV_STRICT=1` blocks instead. Packages in scopes your `.npmrc`/`.yarnrc` maps to a private registry are not sent to OSV. The manager's CVE audit (`pnpm audit`, `npm audit`, `yarn audit`) runs next, on the resolved tree, so a package passed to `add` is audited too. See [the two-phase model](./docs/security.md#two-phase-install).
5. **Build in Docker** — a second container with `--network none` and the token removed runs any lifecycle/build scripts against the downloaded store — nothing to steal, nowhere to send it. See [the two-phase model](./docs/security.md#two-phase-install).
6. **Copy results back** — `node_modules` lands in your project; the lockfile and manifests come from a snapshot taken before any build script ran. The containers are discarded.

---

## Socket.dev Scanning

[Socket](https://socket.dev) adds a third layer — behavioral analysis of package lifecycle scripts (suspicious network calls, obfuscation, typosquatting) — alongside the always-on CVE audit and OSV malware check. It is **opt-in**: authenticate once with `socket login`, then enable it per-command or per-session.

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

## Strict mode (CI)

By default, a scan that could not run (offline, expired token, audit error) warns and the install continues. In CI, set one variable to block instead:

```sh
export SAFE_PNPM_STRICT=1   # block on audit, Socket and OSV findings or failures
export SAFE_PNPM_MEMORY=2g  # optional: memory limit for both containers
```

`SAFE_PNPM_OSV_STRICT=1` and `SAFE_PNPM_SOCKET_STRICT=1` set the same behavior for a single layer.

---

## Bypass

To bypass the wrapper and run the native binary directly:

```sh
command pnpm install   # bash, zsh and fish
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
- [ADR 0001 — two-phase install design and findings](.ai/docs/decisions/0001-two-phase-private-registry.md)
- [Performance — overhead numbers and when they matter](./docs/performance.md)
- [Socket.dev behavioral scanning setup](./docs/socket.md)
- [Contributing](./CONTRIBUTING.md)
