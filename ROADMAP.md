# Roadmap — safe-pnpm

> Goal: A Docker-based package-manager wrapper (pnpm/npm/yarn) that sandboxes install scripts and pre-scans for malicious packages and CVEs.

## Current next action
Open work is tracked as GitHub issues; the gaps left from M4 are in issue #103.

## Milestones
- [x] M0 — Socket CLI wrap: accept a `--socket` flag, call `@socketsecurity/cli` for manifest analysis, gated on `SAFE_PNPM_ENABLE_SOCKET`
- [x] M1 — Failure semantics: findings vs scan-failure are now distinguished via `--report --json` and `socket-classify.js`; failures warn by default, `SAFE_PNPM_SOCKET_STRICT=1` blocks both. Documented in docs/socket.md
- [x] M2 — Tests + docs: cover the Socket flow with tests; add examples to README and CONTRIBUTING.md (issue #7, PR #8)
- [x] M3 — Release pipeline: publish to npm from `publish.yml` on a `v*` tag, with no stored npm token
  - [x] Switch `publish.yml` to npm trusted publishing (PR #13; replaces the planned `NPM_TOKEN` secret)
  - [x] Add the trusted publisher on npmjs.com: user `jboho`, repo `safe-pnpm`, workflow `publish.yml` (issues #15, #16). It needs both "npm publish" and "npm stage publish" permissions
  - [x] First tag-triggered publish succeeds: `v2026.10.2`, run 37359540942 (attempt 3), df9e421
  - [x] Make the GitHub repo public: 2026-10-05; 2026.10.2 carries npm provenance (SLSA v1)
- [x] M4 — Hardening follow-ups
  - [x] Run the containers as a non-root user: host uid/gid via `--user` (PR #37), default user kept under rootless Docker and Podman (PR #38); shipped in 2026.10.3. Windows PowerShell still runs as root; rootless is untested against a real daemon (see README)
  - [x] PowerShell wrappers: add the copy-back link check that sh and fish have (`_safe_pkg_shared.ps1`), and commit behavioral tests for the ps1 paths
  - [x] Tests for the fish Socket-strict and malware-strict paths
  - [x] Run the CVE audit after phase 1 so a package passed to `add` is audited too (OSV already covers malware for it)
- [x] 2026.10.4 released (2026-10-15, PR #74, tag `v2026.10.4`), closing the bypass reports in issues #43-#46:
  - Refuse global installs (PR #52), and refuse directory flags and `--` on scanned commands (PR #73)
  - Scan installs under every alias and after global flags (PR #53)
  - Fetch the host's native optional dependencies: macOS pnpm and yarn (PR #54), PowerShell (PR #55), npm (PR #58)
  - Check `npx`, `dlx` and `create` packages against OSV in bash and zsh (PR #59)
  - Pass `trust-lockfile` as a config setting so pnpm before 11.3 accepts it (PR #69), and put `supportedArchitectures` where pnpm 8 to 10.4 reads it (PR #71)
- [x] 2026.10.6 released (2026-10-18, PR #83, tag `v2026.10.6`):
  - Pass the `npm view` spec after an end-of-options `--` (PR #79)
  - Refuse pnpm installs with `shared-workspace-lockfile=false` (PR #80)
  - Opt-in PATH shims so programs that start pnpm themselves go through the wrappers (PR #81, test fix PR #82)
- [x] 2026.10.7 released (2026-10-19, PR #89, tag `v2026.10.7`):
  - PATH shims on Windows, `.cmd` and `.ps1` (PR #84)
  - Docs on the Windows batch-file limits of `exec`'s double escaping (PR #85)
- [x] 2026.10.8 released (2026-10-19, PR #90, tag `v2026.10.8`): the scan image moves to Node 24.22.0 (PR #87) and `@socketsecurity/cli` to 1.8.4 (PR #86)
- [x] 2026.10.9 released (2026-10-20, PR #93, tag `v2026.10.9`): `~/.npmrc` auth lines whose value is `${NODE_AUTH_TOKEN}` or `${NPM_TOKEN}` reach the fetch phase, for pnpm 11, which ignores those lines in a project `.npmrc` (PR #92)
- [x] 2026.10.10 released (2026-10-21, PR #96, tag `v2026.10.10`): the bash and zsh wrappers print one `Copying node_modules back` line before the copy-back and one `Copied` line after it, and name the folder when a copy fails (PR #95)

## Notes
- docs/socket.md (Socket.dev integration design)
- GitHub repo renamed `jboho/safe-npm` → `jboho/safe-pnpm` on 2026-09-24 (PR #12); old URLs redirect
