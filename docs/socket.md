# Socket.dev Behavioral Scanning

Socket analyzes packages for behavioral signals that go beyond name-matching: suspicious network calls in lifecycle scripts, obfuscated code, typosquatting indicators, new unmaintained packages, and more. It runs as a third pre-install layer alongside `pnpm audit` (CVE database) and the Shai Hulud 2 supply chain scan.

`@socketsecurity/cli` is bundled as a dependency and installed automatically with this package.

## Enabling the scan

Socket is **opt-in**. It needs an authenticated account and makes a network call per install, so it stays off unless you turn it on — the `pnpm audit` (CVE) and Shai Hulud supply chain layers always run regardless.

First authenticate once:

```sh
socket login
```

This opens a browser to create a free account or sign in to an existing one.

Then opt into the scan in one of two ways:

- **Per-invocation** — pass `--socket` to any install-class command. safe-pnpm consumes the flag before the args reach the package manager, so it never confuses `pnpm`/`npm`/`yarn`:

  ```sh
  pnpm install --socket
  npm install --socket
  yarn add lodash --socket
  ```

- **Session/global** — set `SAFE_PNPM_ENABLE_SOCKET=1` so every install-class command includes the scan:

  ```sh
  export SAFE_PNPM_ENABLE_SOCKET=1   # add to your shell profile to make it permanent
  pnpm install
  ```

The flag position matters: put `--socket` after the subcommand (`pnpm install --socket`, not `pnpm --socket install`) so the install-class command is still recognized.

## What you need

Socket scanning requires the `full-scans:create` API permission. A free Socket account is sufficient for individual developers. Check [socket.dev](https://socket.dev) for current plan details.

## What you get

| | No token | Free account | Paid/Org account |
|---|---|---|---|
| CVE audit | ✓ | ✓ | ✓ |
| Shai Hulud supply chain scan | ✓ | ✓ | ✓ |
| Socket behavioral analysis | — | ✓ | ✓ |
| Org-level policy enforcement | — | — | ✓ |
| Scan history & diff | — | — | ✓ |

The Socket step only runs when you opt in (see [Enabling the scan](#enabling-the-scan)); the CVE audit and Shai Hulud supply chain layers always run.

## Keeping Socket up to date

Socket is versioned as a dependency of this package. To update it:

```sh
npm update -g @jboho/safe-pnpm
safe-pnpm update
```
