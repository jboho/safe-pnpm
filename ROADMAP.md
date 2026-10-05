# Roadmap — safe-pnpm

> Goal: A Docker-based package-manager wrapper (pnpm/npm/yarn) that sandboxes install scripts and pre-scans for malicious packages and CVEs.

## Current next action
- [ ] M4 hardening follow-ups (below), remaining: non-root containers, then the CVE audit after phase 1

## Milestones
- [x] M0 — Socket CLI wrap: accept a `--socket` flag, call `@socketsecurity/cli` for manifest analysis, gated on `SAFE_PNPM_ENABLE_SOCKET`
- [x] M1 — Failure semantics: findings vs scan-failure are now distinguished via `--report --json` and `socket-classify.js`; failures warn by default, `SAFE_PNPM_SOCKET_STRICT=1` blocks both. Documented in docs/socket.md
- [x] M2 — Tests + docs: cover the Socket flow with tests; add examples to README and CONTRIBUTING.md (issue #7, PR #8)
- [x] M3 — Release pipeline: publish to npm from `publish.yml` on a `v*` tag, with no stored npm token
  - [x] Switch `publish.yml` to npm trusted publishing (PR #13; replaces the planned `NPM_TOKEN` secret)
  - [x] Add the trusted publisher on npmjs.com: user `jboho`, repo `safe-pnpm`, workflow `publish.yml` (issues #15, #16). It needs both "npm publish" and "npm stage publish" permissions
  - [x] First tag-triggered publish succeeds: `v2026.10.2`, run 37359540942 (attempt 3), df9e421
  - [x] Make the GitHub repo public: 2026-10-05; 2026.10.2 carries npm provenance (SLSA v1)
- [ ] M4 — Hardening follow-ups
  - [ ] Run the containers as a non-root user (no `USER` in `assets/Dockerfile` today; see docs/security.md)
  - [x] PowerShell wrappers: add the copy-back link check that sh and fish have (`_safe_pkg_shared.ps1`), and commit behavioral tests for the ps1 paths
  - [x] Tests for the fish Socket-strict and malware-strict paths
  - [ ] Run the CVE audit after phase 1 so a package passed to `add` is audited too (OSV already covers malware for it)

## Notes
- docs/socket.md (Socket.dev integration design)
- GitHub repo renamed `jboho/safe-npm` → `jboho/safe-pnpm` on 2026-09-24 (PR #12); old URLs redirect
