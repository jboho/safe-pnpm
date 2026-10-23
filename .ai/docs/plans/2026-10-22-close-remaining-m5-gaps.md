# Close the remaining M5 gaps (issues #97-#100)

**Goal:** Close or explicitly defer each of the four open M5 gaps, then tick the M5 milestone in ROADMAP.md.
**Shape:** Four independent issues, one PR each. Order: #100 (security, smallest), #97 (decide first), #98, #99 (CI only). Each fix lands in all three shell families (sh/zsh/bash in `_safe_pkg_shared.sh`, fish in `_safe_pkg_prescan.fish`, PowerShell in `_safe_pkg_shared.ps1`) with tests first.

## #100 Refuse unpinned npx of a command the project doesn't have

**Why:** `_safe_pkg_runner_tail` (`assets/_safe_pkg_shared.sh:234`) returns the bare command word as the spec. When the project has no `node_modules/.bin/<word>`, npx downloads the registry package of that name; `malware-scan.js --specs` resolves it with `npm view` to whatever version is current (for `tsc`, the placeholder `tsc@2.0.4`), and OSV has no entry for it, so the scan passes without saying anything useful.

- [ ] Tests first, per shell (`runner-check.test.js`, `runner-check-fish.test.js`, `ps1-runner-check.test.js`, cases in `test/helpers/runner-cases.js`): `npx tsc` with no local bin is refused with a message naming the fix (`npx tsc@VERSION` or install it); `npx tsc` with `node_modules/.bin/tsc` present runs; `npx tsc@5.6.3` runs; `npx --package typescript@5.6.3 tsc` runs.
- [ ] Apply only to `npx` / `npm exec` / `pnpm dlx` / `yarn dlx` exec mode; `create` mode always fetches a named package and is out of scope.
- [ ] Decide in the PR: does `--package NAME` without a version count as unpinned? Default: yes, refuse, since it is the same unscanned-latest case.
- [ ] Document in README (npx section) and `docs/security.md`.

## #97 Copy .yarnrc.yml into the audit directory

**Finding:** the yarn wrappers are Yarn 1 only (`assets/yarn-wrapper.sh:12`), they never copy `.yarnrc.yml` into the sandbox (`yarn-wrapper.ps1:125`, `yarn-wrapper.fish:166`), and `malware-scan.js:144` refuses Berry lockfiles. npm and pnpm do not read `.yarnrc.yml`. So the audit gap only exists once Yarn Berry is supported.

- [ ] Confirm by test: a Berry project (`yarn.lock` with `__metadata`) is refused before the audit step in all three shells. If so, close #97 as "blocked on Berry support" and put Berry support on ROADMAP as a feature, not under M5.
- [ ] If any path does reach the audit with a `.yarnrc.yml`: copy it next to `.yarnrc` in `_safe_pkg_audit` (`_safe_pkg_shared.sh:353`, `_safe_pkg_shared.ps1:107`, `_safe_pkg_prescan.fish:35`), dropping `yarnPath` and `plugins` (both run project JS on the host), and strip auth lines with the existing strip helper.

## #98 Non-root PowerShell containers on Windows

**Why:** `_Safe_Pkg_User` (`assets/_safe_pkg_shared.ps1:731`) returns no flags on Windows, so both containers run as root there. Windows has no uid to pass.

- [ ] Probe on a real Windows Docker Desktop (WSL2 backend): can `--user 1000:1000` (the image's `node` user) write to a bind-mounted `C:\...` tmp dir, and do copied-back `node_modules` files stay usable by the Windows user? Record the result in this plan.
- [ ] If yes: on Windows return `@('--user', '1000:1000', '-e', 'HOME=/app/.safe-home')`, test-first in `ps1-wrappers.test.js` (stubbed `$IsWindows`). If no: close #98 as a documented limitation, with the probe output in the issue.
- [ ] Update the Windows sentence in `docs/security.md:38` and README.

## #99 Test rootless Docker and Podman against a real daemon

**Why:** rootless detection (plan `2026-10-06-rootless-docker-detection.md`) is only tested with docker stubs; README:45 says so.

- [ ] Add a CI job on `ubuntu-latest`: Podman (preinstalled, rootless by default) via the docker CLI shim, and rootless Docker via `dockerd-rootless-setuptool.sh`. Each runs one real `pnpm install` and one `npm ci` through the wrappers on a small fixture and checks that the copied-back `node_modules` is owned by the runner user.
- [ ] Keep it a separate job so a daemon setup failure does not hide unit-test results; make it required once it has passed on main twice.
- [ ] Remove "not tested against a real rootless daemon" from README:45 and the M4 line in ROADMAP once green.

## Done when

All four issues are closed (fixed, or closed with the reason recorded), and the M5 milestone box is ticked in the PR that closes the last one.
