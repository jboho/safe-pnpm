# M4 hardening follow-up: run the CVE audit after phase 1

**Roadmap item:** M4 hardening follow-ups, remaining: the CVE audit after phase 1.
**Branch:** `feat/audit-after-fetch` (worktree `~/Code/.worktrees/safe-pnpm-audit-after-fetch`, from `origin/main`).

## Problem

The CVE audit runs in the prescan, before the fetch. A package passed to `add` is not in the manifest yet, so it is never audited. OSV (malware) already runs after the fetch and does cover it.

## Approach

Already decided in `.ai/docs/plans/2026-10-05-m4-nonroot-and-audit-after-fetch.md` (its "PR B"). Do not reopen:
- Remove the audit from the prescan.
- Add `_safe_pkg_audit` (sh, fish, ps1). It runs on the host after the fetch, the malware scan and the manifest snapshot, and before the build container.
- Audit a throwaway copy of the snapshot plus the project's registry config, never the project itself.
- pnpm gets `--config.ignore-pnpmfile=true`, so a project `.pnpmfile.cjs` never runs on the host.

## Steps

1. Confirm the non-root PR (`feat/m4-nonroot`) is merged. It already is: #38 and later commits are on main.
2. Write failing tests: audit findings and audit failure now block after the fetch, and `add <pkg>` audits that package.
3. Implement `_safe_pkg_audit` in `_safe_pkg_shared.sh`, the three fish wrappers plus `_safe_pkg_prescan.fish`, and `_safe_pkg_shared.ps1` with the ps1 wrappers.
4. Update `test/hardening*.test.js`, `docs/security.md`, `docs/socket.md`, README (remove the "not covered" note).
5. Run `node --test test/*.test.js` and lint in a container.
6. Tick the sub-item in ROADMAP.md only when the PR merges (`[ ]` to `[x]`, no wording change).

## Out of scope

Version bump, release, Windows non-root.
