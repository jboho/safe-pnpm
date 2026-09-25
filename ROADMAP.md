# Roadmap — safe-pnpm

> Goal: A Docker-based package-manager wrapper (pnpm/npm/yarn) that sandboxes install scripts and pre-scans for malicious packages and CVEs.

## Current next action
- [x] Start M2 (Tests + docs) — see Milestones below

## Milestones
- [x] M0 — Socket CLI wrap: accept a `--socket` flag, call `@socketsecurity/cli` for manifest analysis, gated on `SAFE_PNPM_ENABLE_SOCKET`
- [x] M1 — Failure semantics: findings vs scan-failure are now distinguished via `--report --json` and `socket-classify.js`; failures warn by default, `SAFE_PNPM_SOCKET_STRICT=1` blocks both. Documented in docs/socket.md
- [x] M2 — Tests + docs: cover the Socket flow with tests; add examples to README and CONTRIBUTING.md (issue #7, PR #8)

## Notes
- docs/socket.md (Socket.dev integration design)
