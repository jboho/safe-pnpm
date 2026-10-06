# Rootless Docker/Podman detection Implementation Plan

> **Execution:** hand off to the `run-plan` skill. Steps use `- [ ]` checkboxes for tracking.

**Goal:** When Docker or Podman runs rootless, keep the containers' default user instead of passing `--user UID:GID`, so sandbox files stay owned by the invoking user.
**Architecture:** One new helper per shell (`_safe_pkg_docker_rootless` in sh and fish, `_Safe_Pkg_Docker_Rootless` in PowerShell), called from the existing user-flags helper after the uid check. Rootless detected: the helper prints/returns no flags. Anything unreadable counts as not rootless, so the M4 behavior (`--user`) stays the default.
**Tech stack:** POSIX sh/zsh/bash, fish, PowerShell 7, `node:test`.

## Why

In rootless mode the daemon runs as the user. Container uid 0 maps to that user; any other container uid maps to a subordinate uid (e.g. 100999) the user cannot delete files of. M4 (#37) passes `--user UID:GID`, so under rootless the files written into the bind-mounted sandbox belong to a subordinate uid and cleanup and copy-back fail. Container root under rootless is unprivileged on the host, so dropping `--user` there does not bring back the root exposure M4 removed.

## Detection (sources checked 2026-10-06)

- Docker: `docker info --format '{{json .SecurityOptions}}'` lists the element `"name=rootless"` (moby `daemon/info.go:220`). Docker Desktop on macOS prints `["name=seccomp,profile=builtin","name=cgroupns"]`.
- Podman via its Docker-compatible API (docker CLI pointed at the Podman socket): the same `"name=rootless"` element (podman `pkg/api/handlers/compat/info.go:224`).
- Podman's own CLI (`docker` aliased or shimmed to `podman`): its info has no `SecurityOptions` field, so that template fails with exit 1 (probed the converse on Docker: a template naming a missing field exits 1, `can't evaluate field Host`). The value is `docker info --format '{{.Host.Security.Rootless}}'`, which prints `true` or `false` (podman `libpod/define/info.go:23,66`).
- Rule: if the SecurityOptions query exits 0, rootless iff its output contains `"name=rootless"` (with the quotes). Only if it exits non-zero, rootless iff the Podman query prints exactly `true`. Any other result: not rootless.

## Task 1: detection in sh/zsh, fish and PowerShell, test-first

**Files:** `assets/_safe_pkg_shared.sh`, `assets/_safe_pkg_prescan.fish`, `assets/_safe_pkg_shared.ps1`, `test/two-phase.test.js`, `test/ps1-wrappers.test.js`.

- [ ] Tests first (fail before the change): for each shell (bash, zsh, fish) and each manager, a docker stub whose `info --format '{{json .SecurityOptions}}'` prints `["name=seccomp,profile=builtin","name=rootless"]`: both `run` lines have no `--user` and no `HOME=/app/.safe-home`. A Podman-CLI stub (SecurityOptions template exits 1, Host template prints `true`): same. A stub where both info queries exit 1: both run lines still have `--user UID:GID -e HOME=/app/.safe-home`. The same three cases in `ps1-wrappers.test.js` (one manager is enough there if the wrappers share the helper; say which). Existing tests (stub answers `info` with empty output, exit 0) must keep passing unchanged.
- [ ] sh helper, placed right before `_safe_pkg_user_flags`, called after its uid check: `if _safe_pkg_docker_rootless; then return 0; fi` (prints nothing).
- [ ] fish helper, same placement and call; empty output with status 0 from `_safe_pkg_user_flags`. Avoid `test (cmd) = true` (empty output drops the argument); capture into a variable and quote it.
- [ ] PowerShell `_Safe_Pkg_Docker_Rootless`, called in `_Safe_Pkg_User` after the uid check: return `@()` when rootless.
- [ ] One comment on each helper giving the why (subordinate uid ownership, container root = invoking user, fallback to `--user` when unreadable). No repeated comments at call sites.
- [ ] Run the touched test files, then commit: `fix: keep the default container user under rootless Docker and Podman`.

## Task 2: docs

**Files:** `README.md`, `docs/security.md`.

- [ ] README known gaps: replace the "Rootless Docker or Podman on Linux is untested ..." line with: rootless Docker and Podman are detected from `docker info`, and there the containers keep the default user, which is your user on the host; this is not tested against a real rootless daemon.
- [ ] docs/security.md "Container escape exploits" row: add that under rootless Docker or Podman the containers keep their default user, since its root is your unprivileged user on the host.
- [ ] Commit: `docs: rootless Docker and Podman detection`.

## Task 3: verify and stop

- [ ] Full suite `node --test test/*.test.js`, lint in `node:22-alpine` (`npm run lint`). Report counts.
- [ ] STOP before push. Ask the user: push `feat/rootless-detect` and open a PR into `main`?
