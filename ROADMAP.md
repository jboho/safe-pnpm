# Roadmap — safe-pnpm

> Goal: A Docker-based package-manager wrapper (pnpm/npm/yarn) that sandboxes install scripts and pre-scans for malicious packages and CVEs.

## Current next action
- [ ] Start M3 (Release pipeline) — configure the npm trusted publisher, then cut the first tagged release (plan: .ai/docs/plans/2026-09-24-npm-publish-credentials.md)

## Milestones
- [x] M0 — Socket CLI wrap: accept a `--socket` flag, call `@socketsecurity/cli` for manifest analysis, gated on `SAFE_PNPM_ENABLE_SOCKET`
- [x] M1 — Failure semantics: findings vs scan-failure are now distinguished via `--report --json` and `socket-classify.js`; failures warn by default, `SAFE_PNPM_SOCKET_STRICT=1` blocks both. Documented in docs/socket.md
- [x] M2 — Tests + docs: cover the Socket flow with tests; add examples to README and CONTRIBUTING.md (issue #7, PR #8)
- [ ] M3 — Release pipeline: publish to npm from `publish.yml` on a `v*` tag, with no stored npm token
  - [x] Switch `publish.yml` to npm trusted publishing (PR #13; replaces the planned `NPM_TOKEN` secret)
  - [ ] Add the trusted publisher on npmjs.com: user `jboho`, repo `safe-pnpm`, workflow `publish.yml` (issues #15, #16)
  - [ ] First tag-triggered publish succeeds
  - [ ] Make the GitHub repo public (turns on npm provenance for later releases)

## Notes
- docs/socket.md (Socket.dev integration design)
- GitHub repo renamed `jboho/safe-npm` → `jboho/safe-pnpm` on 2026-09-24 (PR #12); old URLs redirect
