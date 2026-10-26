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
- PowerShell removes an unquoted `--` before the wrapper function sees it, so `npm run build -- --watch` reaches npm as `npm run build --watch`. Quote it to keep it: `npm run build '--' --watch`.
- In PowerShell a refusal is a terminating error (`safe-pnpm: command refused`), so `&&` chains and scripts stop there; catch it with `try`/`catch` if a script should go on. A command the wrapper passes to the real manager sets `$LASTEXITCODE` but leaves `$?` true even when it fails, as with any PowerShell function, so check `$LASTEXITCODE` rather than `&&` after a wrapped command.
- Requires Docker; developed and tested on macOS and Linux CI. On Windows only the PATH shims run in CI (`windows-latest`); the rest is not tested there.

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

If you turned on global PATH shims (`safe-pnpm setup --path-shims`), `command npm` reaches the npm shim and is refused too; run npm by its absolute path instead (`safe-pnpm doctor` lists it, and the refusal message prints it). After upgrading, run `safe-pnpm update` before `safe-pnpm setup --path-shims`; setup refuses to install shims next to wrapper files from another release.

Use `command npm` here. The wrappers refuse `-g` and `--global` installs, because the sandbox would install into a container that is thrown away and change nothing on your machine. Add `command` in front (`command npm install -g PKG`) to run a global install natively, without the safety checks.

### `safe-pnpm exec -- CMD`

Run a program with the safe-pnpm PATH shims first on PATH, for it and everything it starts:

```sh
safe-pnpm exec -- nx mcp
```

The wrappers are shell functions, so a program that starts `pnpm`, `npm`, `npx`, `pnpx` or `yarn` itself (an editor, an MCP server, `child_process.spawn("pnpm")`) skips them. The shims in `~/.safe-pnpm/bin` run the same checks for those programs. `exec` passes the arguments through unchanged and exits with the program's exit code.

To put the shims first on PATH in every new shell instead (opt-in), run `safe-pnpm setup --path-shims`; `safe-pnpm setup --remove-path-shims` undoes it. What the shims cover and what they don't (absolute paths, `npm_execpath`, corepack, Dock-launched apps, CI; on Windows the `.cmd`/`.ps1` shims need PowerShell 7, `--path-shims` edits only the PowerShell profile, and cmd.exe rewrites some arguments), plus MCP server recipes: [docs/security.md](./docs/security.md#path-shims-for-programs-that-start-a-package-manager).

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
  ✓  PATH shims       pnpm, pnpx, npm, npx in ~/.safe-pnpm/bin
  ✓  Shims on PATH    not on PATH (scoped: use safe-pnpm exec -- CMD, or setup --path-shims)

  Package managers on PATH, in lookup order
  pnpm
        ~/Library/pnpm/pnpm
  ...
```

---

## How It Works

When you run an install-class command:

| Manager | Intercepted subcommands |
|---|---|
| pnpm | `install`, `add`, `update`, `ci`, `remove`, `fetch` |
| npm | `install`, `i`, `ci`, `update`, `uninstall`, `un` |
| yarn | `install`, `add`, `remove`, `upgrade` (yarn v1 only) |

**Flags that point an install at another directory are refused.** The checks read the lockfile in the directory you run the command from, so an install sent elsewhere would go unchecked. On an intercepted command the wrappers refuse npm's `--prefix` and `-C`, pnpm's `-C`, `--dir`, `--prefix` and `--lockfile-dir` (also as `--config.dir=` and similar), and yarn's `--cwd`, in any position, in the `--flag=DIR` form and in the shortened or single-dash spellings the managers accept. `cd` into that directory and run the command there, or put `command` in front (`command pnpm -C web install`) to run it natively without the safety checks. Commands that aren't intercepted, such as `pnpm -C web run build`, are not affected. pnpm installs are also refused when the project's `.npmrc` sets `lockfile-dir` or its `pnpm-workspace.yaml` sets `lockfileDir`; remove the setting to install through the wrapper. They are refused too when `shared-workspace-lockfile` is false (in `.npmrc`, as `sharedWorkspaceLockfile` in `pnpm-workspace.yaml`, or on the command line), since each workspace member would keep its own lockfile and there is no root lockfile to scan; set it back to true to install through the wrapper.

**`--` is refused on intercepted commands.** The sandbox adds `--ignore-scripts` and its other flags after your arguments. After `--` (or `---`, which npm and pnpm read the same way) the managers would take those flags as package names, and install scripts would run in the fetch phase, which has your registry token and the network. Drop the `--`, or put `command` in front to run it natively without the safety checks. Commands that aren't intercepted, such as `npm run test -- --watch`, get the `--` unchanged.

**Yarn 2+ (Berry) projects are refused.** The sandbox runs Yarn 1, which cannot read a Berry lockfile: it would resolve every version again and replace your `yarn.lock` with a Yarn 1 lockfile, losing its pins. yarn installs are refused when the current directory's `yarn.lock` starts with a `__metadata:` block, a `.yarnrc.yml` file is present, or `package.json` sets `packageManager` to `yarn@2` or later. Put `command` in front (`command yarn install`) to run it natively without the safety checks. The check reads the current directory only, so it misses a member folder of a Berry workspace. Full Berry support is tracked in [issue 106](https://github.com/jboho/safe-pnpm/issues/106).

**Download-and-run commands get a malware check only.** These fetch a package and run it straight away, so they skip the Docker sandbox, the CVE audit and Socket, and the package's code runs on your machine with your permissions:

- `npx PKG`, `npm exec PKG`, `npm init PKG`, `npm create PKG`
- `pnpm dlx PKG`, `pnpx PKG`, `pnpm create PKG`
- `yarn create PKG`, and `yarn dlx PKG` on yarn 2+

In bash, zsh, fish and PowerShell (not yet tested on native Windows) the wrappers look up the version the command would fetch (`npm view`, which reads registry metadata and runs no package code), check that `name@version` against [OSV](https://osv.dev)'s malicious-package advisories, and refuse to run the command on a hit. A `create` command checks the `create-` package the manager would fetch. If OSV or the lookup fails the command warns and runs; `SAFE_PNPM_OSV_STRICT=1` blocks instead. Paths, URLs, git specs and packages in private scopes are not checked. `npx` is wrapped only when the npm wrapper is enabled, and `pnpx` only with the pnpm wrapper. OSV only knows packages already reported as malicious, so treat anything new with care and check the name yourself.

A download-and-run command that names no version is refused when it would download, even if OSV finds nothing and even if OSV is down. OSV can only vouch for a package it has seen, and a bare command name may fetch an unrelated package: `npx tsc` without TypeScript installed fetches the `tsc` package, not TypeScript. Name a version (`npx cowsay@1.5.0`), or `@latest` to take the newest on purpose (`npx cowsay@latest`). For `npx` and `npm exec`, a command already installed in the project, a parent folder's `node_modules`, or npm's global folder runs as before, since npm runs that copy instead of downloading. `pnpm dlx`, `pnpx` and `yarn dlx` always download, so they always need a version. `create` and `init` commands are not affected. With the [PATH shims](./docs/security.md#path-shims-for-programs-that-start-a-package-manager) installed, this also refuses MCP server configs that start a server with `npx -y PKG`: add a version to the package name there.

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

## Native optional dependencies on macOS

Packages such as rollup and esbuild ship one native build per platform as optional dependencies. The install runs in a Linux container, so it would pick only the Linux build, and tools you run on the Mac afterwards fail with `Cannot find module @rollup/rollup-darwin-arm64`.

On a Mac or Windows host the wrapper also fetches the Mac build, and it goes through the same malware check and CVE audit as everything else:

- **pnpm** — the sandbox copy of the project gets `supportedArchitectures` for the host: in `pnpm-workspace.yaml` when the project pins no pnpm or pnpm 11 or later, and in the `pnpm` field of `package.json` when `packageManager` or `devEngines.packageManager` pins pnpm 10 or earlier, or a version or range the wrapper can't place (such as `pnpm@latest` or `>=9`). pnpm before 10.5 rejects a workspace file without `packages`, and pnpm 8 and 9 don't read the setting there. For those projects the image's pnpm 11 warns that it ignores `pnpm.supportedArchitectures` before it hands off to the pinned pnpm, which reads it. Your own files are not changed (a `pnpm add` keeps its new dependency, without the setting), and a `supportedArchitectures` you already set is kept. This needs `pnpm-arch.js` in `~/.safe-pnpm/`; run `safe-pnpm update` if the wrapper warns that it is missing.
- **yarn** — `--ignore-platform`, which fetches the builds for every platform (yarn 1 cannot name one).
- **npm** — after the fetch, the wrapper installs the lockfile's optional packages built for the host next to the Linux ones (`npm install --no-save --ignore-scripts`), by name and version from the lockfile that was just malware-scanned. `--os`/`--cpu` can't do this: they replace the container's platform, which breaks esbuild's install script in the build container. This needs `host-specs.js` in `~/.safe-pnpm/`; run `safe-pnpm update` if the wrapper warns that it is missing.

Known limit for npm: the extra install fetches `name@version` from the registry again and does not check the lockfile's integrity hash. A nested lockfile entry (inside another package's `node_modules`) is installed at the top level instead. The malware scan and CVE audit cover the same name and version that gets installed.

On Windows the extra build is `win32`. Running `command pnpm install` to get around this skips the malware scan; use the above instead.

---

## Bypass

To bypass the wrapper and run the native binary directly:

```sh
command pnpm install   # bash, zsh and fish
command npm install
command yarn install

# With setup --path-shims, `command pnpm` reaches the shim; run the real
# binary by absolute path instead (safe-pnpm doctor lists them).

# PowerShell. With setup --path-shims, pnpm.cmd is the shim; run the
# real binary by absolute path instead.
pnpm.cmd install
npm.cmd install
yarn.cmd install
```

---

## Private Registries

Private and scoped registries work out of the box. Map the scope in the
project's `.npmrc`, put the auth line in your `~/.npmrc` with the token as a
variable (`//npm.acme.example/:_authToken=${NPM_TOKEN}`), and install normally:

```sh
export NPM_TOKEN=your-read-only-token   # or NODE_AUTH_TOKEN
pnpm install
```

The wrapper copies only the `~/.npmrc` auth lines whose value is exactly
`${NODE_AUTH_TOKEN}` or `${NPM_TOKEN}` into the fetch phase; literal tokens stay
on the host. pnpm 11 ignores a `${NPM_TOKEN}` auth line in the project `.npmrc`.

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
| fish | `~/.config/fish/functions/{pnpm,npm,yarn}.fish` (one per enabled manager), plus `npx.fish` with npm and `pnpx.fish` with pnpm |
| PowerShell | `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` |

---

## Further Reading

- [Security model — what's protected and what isn't](./docs/security.md)
- [Private registries — token-safe private/scoped installs](./docs/private-registry.md)
- [ADR 0001 — two-phase install design and findings](.ai/docs/decisions/0001-two-phase-private-registry.md)
- [Performance — overhead numbers and when they matter](./docs/performance.md)
- [Socket.dev behavioral scanning setup](./docs/socket.md)
- [Contributing](./CONTRIBUTING.md)
