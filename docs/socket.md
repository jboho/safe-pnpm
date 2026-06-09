# Socket.dev Behavioral Scanning

Socket analyzes packages for behavioral signals that go beyond name-matching: suspicious network calls in lifecycle scripts, obfuscated code, typosquatting indicators, new unmaintained packages, and more. It runs as a third pre-install layer alongside `pnpm audit` (CVE database) and the Shai Hulud 2 supply chain scan.

`@socketsecurity/cli` is bundled as a dependency and installed automatically with this package.

## Setup

Authenticate once to activate scanning:

```sh
socket login
```

This opens a browser to create a free account or sign in to an existing one. After that, every `pnpm install` automatically includes the Socket behavioral scan — no further configuration needed.

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

Without a token, the Socket step is silently skipped — the other two scan layers still run.

## Keeping Socket up to date

Socket is versioned as a dependency of this package. To update it:

```sh
npm update -g @jboho/safe-pnpm
safe-pnpm update
```
