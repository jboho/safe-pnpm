# @jboho/safe-pnpm

A Docker-based pnpm install isolation wrapper that protects developer machines from malicious npm package lifecycle scripts (`postinstall`, `preinstall`, etc.).

When you run `pnpm install`, the wrapper pre-scans for known CVEs and malicious packages, runs the install inside an ephemeral Docker container that only sees your `package.json` and lockfile (never source files, `.env`, or credentials), then copies `node_modules` back. All other pnpm commands pass through instantly with no overhead.

## Install

```sh
npm install -g @jboho/safe-pnpm
safe-pnpm setup
```

Requires: Docker Desktop 4.0+, Node.js 16+, pnpm 7.0+

---

## Commands

### `safe-pnpm setup`

Interactive first-time installation. Checks prerequisites, optionally configures a corporate CA certificate, builds the `safe-pnpm:latest` Docker image, and wires the `pnpm` shell function into your shell config.

```sh
safe-pnpm setup
source ~/.zshrc    # or open a new terminal
```

### `safe-pnpm update`

Refresh wrapper files and rebuild the Docker image after a package update:

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
  ✓  Wrapper files    all 6 files present
  ✓  Shell config     source line found in ~/.zshrc
  ✓  pnpm             10.33.0
  ✓  Node.js          v22.0.0
  ✓  CA cert          not configured (no TLS proxy)
```

---

## How It Works

When you run `pnpm install` (or `add`, `update`, `ci`, `remove`, `fetch`):

1. **Pre-install scan** — `pnpm audit` for known CVEs, Shai Hulud 2 malicious package check, and [Socket behavioral analysis](./docs/socket.md) if configured.
2. **Copy only manifests** — `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` go into a temp directory. Source files, `.env`, and secrets never leave the host.
3. **Run in Docker** — ephemeral container, `--cap-drop ALL`, no home directory or credential access.
4. **Copy results back** — `node_modules` and the updated lockfile land in your project. The container is discarded.

---

## Bypass

```sh
\pnpm install         # bash/zsh/fish
command pnpm install  # any POSIX shell
pnpm.cmd install      # PowerShell
```

---

## Corporate CA Certificate

If your network uses TLS inspection (Zscaler, etc.), provide your CA certificate during `safe-pnpm setup`. It's embedded in the Docker image at build time. To update after a cert rotation: `safe-pnpm update`.

---

## Private Registries

`NODE_AUTH_TOKEN` and `NPM_TOKEN` are forwarded into the container automatically when set in your environment.

---

## Shell Support

| Shell | Config modified |
|---|---|
| zsh | `~/.zshrc` |
| bash (macOS) | `~/.bash_profile` |
| bash (Linux) | `~/.bashrc` |
| fish | `~/.config/fish/functions/pnpm.fish` |
| PowerShell | `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` |

---

## Further Reading

- [Security model — what's protected and what isn't](./docs/security.md)
- [Performance — overhead numbers and when they matter](./docs/performance.md)
- [Socket.dev behavioral scanning setup](./docs/socket.md)
- [Contributing](./CONTRIBUTING.md)
