# Roadmap — safe-pnpm

> Goal: A Docker-based package-manager wrapper (pnpm/npm/yarn) that sandboxes install scripts and pre-scans for malicious packages and CVEs.

## Current next action
- [ ] Start M0 (Socket CLI wrap) — see Milestones below

## Milestones
- [ ] M0 — Socket CLI wrap: accept a `--socket` flag, call `@socketsecurity/cli` for manifest analysis, gated on `SAFE_PNPM_ENABLE_SOCKET`
- [ ] M1 — Failure semantics: define warn-vs-block behavior when a Socket scan fails; document in docs/socket.md
- [ ] M2 — Tests + docs: cover the Socket flow with tests; add examples to README and CONTRIBUTING.md

## Notes
- docs/socket.md (Socket.dev integration design)
