# Performance

Install-class commands (`install`, `add`, `update`, `ci`, `remove`, `fetch`) run via Docker. Everything else — `run`, `build`, `test`, `exec`, `--version` — passes through instantly with no overhead.

## Typical overhead

Measured on Apple Silicon with a warm Docker daemon:

| Project size | Overhead |
|---|---|
| Small (< 100 packages) | ~3–5s |
| Medium (100–350 packages) | ~15–30s |
| Large (350+ packages) | ~45–90s |

Most of the overhead on large projects is **copy-back** — moving `node_modules` out of the container and onto your local filesystem after the install completes. The install itself is fast; the `cp -r` is the bottleneck.

## When the overhead matters

`pnpm install` is not a hot path. You run it when:

- Switching to a branch with dependency changes
- After a fresh clone
- When adding or removing a package

A few extra seconds or even a minute is acceptable in those contexts. The commands you run constantly — `pnpm run dev`, `pnpm test`, `pnpm build` — are completely unaffected.

## First run vs. subsequent runs

The Docker daemon does a cold start on the first install of a terminal session (~10–15s additional). Subsequent installs in the same session reuse the warm daemon and are noticeably faster.

## Bypass when needed

If you need native speed for a one-off install (e.g., quickly trying a package):

```sh
\pnpm install         # bash/zsh/fish
command pnpm install  # any POSIX shell
pnpm.cmd install      # PowerShell
```
