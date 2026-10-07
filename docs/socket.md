# Socket.dev Behavioral Scanning

Socket analyzes packages for behavioral signals that go beyond name-matching: suspicious network calls in lifecycle scripts, obfuscated code, typosquatting indicators, new unmaintained packages, and more. It runs as a third layer alongside `pnpm audit` (CVE database, after the fetch) and the OSV malware check.

`@socketsecurity/cli` is bundled as a dependency and installed automatically with this package.

## Enabling the scan

Socket is **opt-in**. It needs an authenticated account and makes a network call per install, so it stays off unless you turn it on — the `pnpm audit` (CVE) and OSV malware check always run regardless.

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

## Failure semantics

A Socket run has three possible outcomes, and safe-pnpm treats them differently. The distinction that matters is **"Socket says these packages are bad"** versus **"Socket could not tell us anything"** — a scan that never ran is not evidence of a problem, and reporting it as one trains you to ignore the warning.

| Outcome | What happened | Default behavior | With `SAFE_PNPM_SOCKET_STRICT=1` |
|---|---|---|---|
| **Pass** | Scan completed, report is healthy | Install proceeds | Install proceeds |
| **Findings** | Scan completed, report is unhealthy — packages violate your org's policy at the report level | Interactive: prompt `Continue anyway? [y/N]`. Non-interactive: warn and continue | **Block** |
| **Failure** | Scan could not run — no API token, network or API error, quota exhausted, CLI crash, Socket not installed | Warn and continue, naming the cause | **Block** |

Findings follow the same convention as the `pnpm audit` layer: they prompt when there's a human to ask, and warn without blocking when there isn't.

Failures are deliberately lenient by default and never prompt. Socket is an opt-in third layer: the CVE audit and the OSV malware check still run after the fetch. Breaking every install because a token expired or a laptop is offline costs more than it protects — so safe-pnpm tells you the layer didn't run and moves on.

### Strict mode

Set `SAFE_PNPM_SOCKET_STRICT=1` to turn both findings and failures into hard blocks:

```sh
export SAFE_PNPM_SOCKET_STRICT=1
```

This is the setting for CI. Without it, a pipeline whose Socket token has expired keeps going green while silently doing no behavioral scanning at all — the failure mode strict mode exists to prevent. Strict mode also blocks when Socket is enabled but not installed, since the requested layer cannot run.

Strict mode only applies when the scan is enabled in the first place (via `--socket` or `SAFE_PNPM_ENABLE_SOCKET=1`). On its own it does not turn the scan on.

### How the outcomes are told apart

`socket scan create` exits `1` both when the scan failed and when the report is unhealthy, so the exit code alone cannot distinguish them. safe-pnpm runs the scan with `--report --json` and classifies the result envelope in `socket-classify.js`:

- `ok: false` → **failure**, with the CLI's own `cause` shown to you
- exit code `2` (input/config error, e.g. no token or no resolvable org) → **failure**, with a `socket login` hint
- `ok: true` and `data.healthy: false` → **findings**
- `ok: true` and `data.healthy: true` → **pass**
- anything unparseable, empty, or missing a report verdict → **failure**, never a silent pass

The `--report` flag is required for this: without it, `scan create` only uploads the manifest and returns, so findings could never surface at all. It does mean the install waits for the scan to complete.

Every unrecognized state resolves to *failure*, not *pass* — safe-pnpm will not claim the layer ran when it cannot prove it did.

## What you need

Socket scanning requires the `full-scans:create` API permission. A free Socket account is sufficient for individual developers. Check [socket.dev](https://socket.dev) for current plan details.

## What you get

| | No token | Free account | Paid/Org account |
|---|---|---|---|
| CVE audit | ✓ | ✓ | ✓ |
| OSV malware check | ✓ | ✓ | ✓ |
| Socket behavioral analysis | — | ✓ | ✓ |
| Org-level policy enforcement | — | — | ✓ |
| Scan history & diff | — | — | ✓ |

The Socket step only runs when you opt in (see [Enabling the scan](#enabling-the-scan)); the CVE audit and OSV malware check always run.

## Keeping Socket up to date

Socket is versioned as a dependency of this package. To update it:

```sh
npm update -g @jboho/safe-pnpm
safe-pnpm update
```
