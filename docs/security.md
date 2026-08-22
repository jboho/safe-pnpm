# Security Model

## What This Protects — And What It Doesn't

Being honest about the threat model matters. This tool addresses a specific, high-value attack surface. It does not claim to solve all supply chain risk.

### What it protects

The most dangerous moment in an npm supply chain attack is **install time**. Malicious packages run `preinstall`/`postinstall` scripts the moment `pnpm install` executes. Those scripts can:

- Read `~/.ssh/` and exfiltrate private keys
- Read `~/.aws/credentials` and steal cloud access
- Read `.env` files in every project they can find
- Install persistent backdoors on the host

Inside the Docker container, **none of this is possible**. The container has no home directory mount, no access to other projects, and all Linux capabilities are dropped. Installs run in [two phases](#two-phase-install): dependencies are downloaded with lifecycle scripts disabled, then any build scripts run in a second container with **no network** (`--network none`) and **no registry token**. Even if a malicious package's lifecycle script runs, it finds nothing worth stealing and cannot phone home — and the container is thrown away immediately after.

| Threat | Protected |
|---|---|
| Credential theft via postinstall/preinstall scripts | Yes — container has no access to `~/.ssh`, `~/.aws`, other projects |
| Source file exfiltration | Yes — source files are never mounted |
| `.env` and secret theft | Yes — only `package.json` and lockfile enter the container |
| Persistent host backdoors | Yes — container is discarded after install |
| Known CVE-listed packages | Yes — caught by `pnpm audit` pre-install |
| Known malicious packages (Shai Hulud 2 campaign) | Yes — caught by live scan pre-install |
| Behavioral anomalies (suspicious network calls, etc.) | Yes, with [Socket.dev](./socket.md) configured |

### What it doesn't protect

| Threat | Notes |
|---|---|
| Malicious code that runs at build/test time | `pnpm run build` and `pnpm test` execute on the host. Installed packages run with your full permissions. |
| Novel, unlisted attack packages | Pre-install scans only catch packages in their databases. A zero-day campaign won't appear until the lists update. |
| Container escape exploits | Rare kernel CVEs exist. `--cap-drop ALL` significantly reduces the surface but is not absolute. |
| Malicious registry response exploiting the client | Out of scope. The fetch phase runs the package manager against your configured registry; a compromised registry attacking the client itself is not defended against. |

## Two-phase install

Every install runs as two throwaway containers:

1. **Fetch** — network on, registry token available, `--ignore-scripts`. Resolves and downloads every dependency into a store on the sandbox volume. No package code runs, so a token cannot be read or exfiltrated here.
2. **Build** — `--network none`, token withheld, `.npmrc` credential lines stripped. Any lifecycle/build scripts run against the already-downloaded store with nothing to steal and nowhere to send it.

Because the token and untrusted code are never present at the same time, private-registry installs no longer require the old `SAFE_PNPM_FORWARD_TOKENS` opt-in — see [private-registry.md](./private-registry.md). Set `SAFE_PNPM_BUILD_NETWORK=1` if a package's build genuinely needs network (e.g. `esbuild`, `sharp`); the token is still withheld in that phase.

### Why it's still valuable despite those limits

The vast majority of real-world npm supply chain attacks happen at install time. This is not an accident — it's the easiest attack vector: a malicious package author knows exactly when `postinstall` runs and what credentials are nearby. Attacks like the 2021 `ua-parser-js` compromise, the 2022 `node-ipc` incident, and the 2024 Shai Hulud 2 campaign all triggered at install.

The risk that `node_modules` code executes maliciously during `pnpm run build` is real but lower — it requires the attacker to inject logic that activates in the build environment specifically, is harder to weaponize portably across codebases, and is more likely to be caught by behavioral analysis tools like Socket.

This tool eliminates the easiest, most common vector. It does not replace code review, dependency auditing, or keeping lockfiles up to date. It's one layer in a defense-in-depth stack.
