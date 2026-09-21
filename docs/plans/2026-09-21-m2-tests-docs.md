# M2 — Tests + docs

Goal: cover the Socket flow (M0/M1) with tests, and add usage examples to README and CONTRIBUTING.md.

## Scope

- Unit/integration tests for the `--socket` flag path (`@socketsecurity/cli` invocation, gated on `SAFE_PNPM_ENABLE_SOCKET`).
- Tests for `socket-classify.js` findings-vs-scan-failure classification (extends existing edge-case coverage).
- Tests for strict mode behavior (`SAFE_PNPM_SOCKET_STRICT=1` blocking both findings and failures) vs default warn-only behavior.
- README: add a Socket scanning usage example (flag, env vars, expected output).
- CONTRIBUTING.md: add a section on running/extending the Socket test suite.

## Out of scope

- New Socket features or classifier logic changes (belongs to M0/M1, already done).
- CI pipeline changes.

## State at spec time (2026-09-21)

Most of the scope already landed ahead of this issue. Audit before writing anything new:

- **Tests — done.** `test/socket.test.js` covers the `--socket` flag path, `SAFE_PNPM_ENABLE_SOCKET` gating, `_safe_pkg_dispatch` flag-stripping, and all strict-mode outcomes (findings, scan failure, unconfigured, missing install). `test/socket-classify.test.js` has 27 classifier cases including JSON-parsing edge cases. Landed in `2f6d99f` / `5480c6e`. All 83 tests pass (4 PowerShell parse tests skip without `pwsh`).
- **README — done.** The "Socket.dev Scanning" section documents the flag, both env vars, and flag position. Links to `docs/socket.md` for the full outcome table.
- **docs/socket.md — done** (PR #6): enabling, failure semantics, outcome table, account tiers.
- **CONTRIBUTING.md — the remaining gap.**

## Remaining work

1. **Fix stale test claims in CONTRIBUTING.md.** The "Running Tests" section states tests cover only `lib/util/` and that command/wrapper code is not tested. That is now wrong — the shared shell library (`assets/_safe_pkg_shared.sh`) and the Socket classifier are both under test. Correct it.
2. **Fix the Project Structure tree.** `test/  *.test.js  Unit tests for lib/util/` is stale; the tree also omits the shared shell assets that the tests exercise.
3. **Add a "Socket test suite" subsection** explaining how the tests work and how to extend them: the `runShared` bash harness with its stub `socket` binary, the `classify` helper, the three classifier exit codes (0 pass / 3 findings / 4 failed), and how to add a new outcome case.

## Approach

1. Audit current coverage (done — see State above).
2. No new test code needed; coverage already meets the plan's test goals. Add tests only if a concrete gap surfaces.
3. README already carries the usage example; add a short sample of warning output so the "expected output" item is literally met.
4. Rewrite the CONTRIBUTING.md test sections for accuracy and add the Socket test-suite guidance.
