# Security Model

## What This Protects — And What It Doesn't

Being honest about the threat model matters. This tool addresses a specific, high-value attack surface. It does not claim to solve all supply chain risk.

### What it protects

The most dangerous moment in an npm supply chain attack is **install time**. Malicious packages run `preinstall`/`postinstall` scripts the moment `pnpm install` executes. Those scripts can:

- Read `~/.ssh/` and exfiltrate private keys
- Read `~/.aws/credentials` and steal cloud access
- Read `.env` files in every project they can find
- Install persistent backdoors on the host

Inside the Docker container, none of this is reachable: the container has no home directory mount and no access to other projects. On macOS and Linux it runs as your own user rather than root (see the table below for Windows), all Linux capabilities are dropped, and `no-new-privileges` and a process limit are set. Installs run in [two phases](#two-phase-install): dependencies are downloaded with lifecycle scripts disabled, then any build scripts run in a second container with **no network** (`--network none`) and **no registry token**. Even if a malicious package's lifecycle script runs, it finds nothing worth stealing and cannot phone home — and the container is thrown away immediately after. Only `node_modules` comes back to the host; `package.json`, the lockfile, and workspace manifests are restored from a snapshot taken before any script ran, so a build script cannot rewrite them to run code the next time you use the project.

| Threat | Protected |
|---|---|
| Credential theft via postinstall/preinstall scripts | Yes — container has no access to `~/.ssh`, `~/.aws`, other projects |
| Source file exfiltration | Yes — source files are never mounted |
| `.env` and secret theft | Yes — only `package.json` and lockfile enter the container |
| Persistent host backdoors via manifests | Yes — the container is discarded, and manifests and the lockfile are restored from the pre-build snapshot, so build scripts cannot plant `scripts` entries or new dependencies |
| Known CVE-listed packages | Partly — `audit` runs after the fetch, on the tree the fetch resolved, so a package passed to `add` is covered. Its output is shown. Interactive runs prompt; non-interactive runs warn and continue unless `SAFE_PNPM_STRICT=1`, which blocks (and also blocks when the audit itself could not run) |
| Known malicious packages | Yes — every version the fetch resolved is checked against [OSV](https://osv.dev)'s malicious-package advisories (`MAL-*`, which include the Shai-Hulud 2.0 IOC lists) before any package code runs; a hit blocks the install |
| Behavioral anomalies (suspicious network calls, etc.) | Yes, with [Socket.dev](./socket.md) configured |

### What it doesn't protect

| Threat | Notes |
|---|---|
| Malicious code that runs at build/test time | `pnpm run build` and `pnpm test` execute on the host. Installed packages run with your full permissions. |
| Novel, unlisted attack packages | Pre-install scans only catch packages in their databases. A zero-day campaign won't appear until the lists update. |
| Build scripts tampering with `node_modules` | Build scripts can modify files anywhere in the `node_modules` tree that is copied back, including other packages and `.bin` shims. That code runs on the host the next time you build or test, the same exposure as build/test-time code above. |
| Container escape exploits | Rare kernel CVEs exist. `--cap-drop ALL`, `--security-opt no-new-privileges` and `--pids-limit 1024` reduce the surface but are not absolute. Both containers run as your user (`--user` with your uid and gid), not root. Under rootless Docker or Podman they keep their default user instead, since root in them is your unprivileged user on the host. They run as root if you invoke the install as root (for example under `sudo` or in a root CI container), since `id -u` is then 0; if the uid cannot be read, the install is refused rather than run as root. On Windows the PowerShell wrappers still run them as root, because Windows has no uid to pass. No memory limit unless `SAFE_PNPM_MEMORY` is set. |
| Sandbox files left behind | The sandbox directories hold a copy of `.npmrc` (token included) while an install runs. They are removed on exit and on Ctrl-C/SIGTERM; a `kill -9` or power loss leaves them in the system temp directory. |
| Malicious registry response exploiting the client | Out of scope. The fetch phase runs the package manager against your configured registry; a compromised registry attacking the client itself is not defended against. |

## Two-phase install

Every install runs as two throwaway containers:

1. **Fetch** — network on, registry token available, `--ignore-scripts`. Resolves and downloads every dependency into a store on the sandbox volume. No package code runs, so a token cannot be read or exfiltrated here.
2. **Malware check** — on the host, every package version in the lockfile the fetch resolved (including anything `add` just pulled in) is checked against OSV's malicious-package advisories. A hit discards the sandbox: nothing is built or copied back. If the check can't run (offline, OSV down) the install warns and continues; set `SAFE_PNPM_OSV_STRICT=1` to block instead. Package names and versions are sent to `api.osv.dev`, except packages in scopes that `.npmrc`/`.yarnrc` map to a non-public registry. Unscoped private packages served through a `registry=` override are indistinguishable from public ones and are sent.
3. **Build** — `--network none`, token withheld, `.npmrc` credential lines stripped. Any lifecycle/build scripts run against the already-downloaded store with nothing to steal and nowhere to send it.
4. **Copy-back** — `node_modules` returns to the host only at the project root and in workspace members that existed before the install; a `node_modules` that is a symlink or does not resolve to its expected path is refused and the install exits non-zero. Symlinks inside `node_modules` are kept as links (pnpm's layout depends on them), so each one must point inside the project: an absolute target, or one that climbs above the project root, refuses that `node_modules` and the install exits non-zero. The check (`link-check.js`) runs on the host with `node`; if it is missing, copy-back is refused. `package.json`, the lockfile, and member manifests are copied back from a snapshot taken after the fetch phase, never from the build container.

### Strict mode

By default a scan that could not run warns and the install continues, so an offline laptop or an expired token does not break work. For CI, `SAFE_PNPM_STRICT=1` turns every layer into a hard block: an audit that finds issues or fails, a Socket scan that finds issues or fails, and an OSV scan that fails (OSV findings always block). `SAFE_PNPM_SOCKET_STRICT=1` and `SAFE_PNPM_OSV_STRICT=1` set the same behavior for one layer.

Because the token and untrusted code are never present at the same time, private-registry installs no longer require the old `SAFE_PNPM_FORWARD_TOKENS` opt-in — see [private-registry.md](./private-registry.md). Set `SAFE_PNPM_BUILD_NETWORK=1` if a package's build genuinely needs network (e.g. `esbuild`, `sharp`); the token is still withheld in that phase.

### Why it's still valuable despite those limits

The vast majority of real-world npm supply chain attacks happen at install time. This is not an accident — it's the easiest attack vector: a malicious package author knows exactly when `postinstall` runs and what credentials are nearby. Attacks like the 2021 `ua-parser-js` compromise, the 2022 `node-ipc` incident, and the 2025 Shai-Hulud 2.0 campaign all triggered at install.

The risk that `node_modules` code executes maliciously during `pnpm run build` is real but lower — it requires the attacker to inject logic that activates in the build environment specifically, is harder to weaponize portably across codebases, and is more likely to be caught by behavioral analysis tools like Socket.

This tool eliminates the easiest, most common vector. It does not replace code review, dependency auditing, or keeping lockfiles up to date. It's one layer in a defense-in-depth stack.
