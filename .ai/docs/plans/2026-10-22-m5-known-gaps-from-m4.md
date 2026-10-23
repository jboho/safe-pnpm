# M5 — Known gaps from M4

Date: 2026-10-22. Roadmap item: `M5 — Known gaps from M4 (open gaps: issues #97-#100)`.

M5's two listed sub-items (OSV checks for npx/dlx/create in fish, #60, and PowerShell, #61) are done. What is left is the four gaps moved to issues on 2026-10-21. Each one lands as its own PR off `main`; M5 closes when all four are closed, and a release PR ships them.

## 1. Copy `.yarnrc.yml` into the audit directory (#97)

Today: `_safe_pkg_audit` (`assets/_safe_pkg_shared.sh:342`), its PowerShell twin (`assets/_safe_pkg_shared.ps1:101`) and the fish prescan (`assets/_safe_pkg_prescan.fish:26`) copy `.npmrc` and `.yarnrc` (minus `yarn-path`) but not `.yarnrc.yml`, so Yarn Berry registry settings are missing during the audit.

Steps:
- Check first whether Berry works in the sandbox at all: `assets/yarn-wrapper.sh:23` and `assets/yarn-wrapper.fish:166` copy only `package.json yarn.lock .yarnrc .npmrc`. If `.yarnrc.yml` never reaches the sandbox, add it there too.
- Copy `.yarnrc.yml` into the audit dir with the keys that run code on the host removed: `yarnPath` and `plugins` (same reason `yarn-path` is stripped from `.yarnrc`). Keep `npmScopes`, `npmRegistryServer`, auth keys (already handled by the token-strip helpers at `_safe_pkg_shared.sh:778`).
- Check that the audit command fits Berry: the code runs `yarn audit`, which Berry replaced with `yarn npm audit`. If Berry audit is broken today, fix it in the same PR or file it separately.
- Tests: extend `test/hardening.test.js` and `test/hardening-fish.test.js` (which already cover `.yarnrc`) plus the ps1 equivalent.

## 2. Refuse unpinned npx of a command the project doesn't install (#100)

Today: `_safe_pkg_runner_specs` (`assets/_safe_pkg_shared.sh:183`, fish `_safe_pkg_prescan.fish:161`, ps1 equivalent) collects specs and `malware-scan.js --specs` resolves and checks them. For `npx tsc`, npm resolves the placeholder package `tsc`, which OSV knows nothing useful about, so the scan passes without telling the user anything.

Steps:
- Decide what "installed" means: the command is in `node_modules/.bin` of the working directory or a parent (how npx itself looks it up). Confirm against npm 10 and 11 before writing the check.
- When a spec has no version and the command is not installed, refuse with a message that says to name a version (`npx tsc@5.6.3`) or to install it. A spec with a version, tag or range still goes to OSV as now.
- Put the rule in one place if possible (`malware-scan.js --specs` gets the cwd) so sh, fish and ps1 don't each grow their own copy.
- Tests: `test/helpers/runner-cases.js` feeds `runner-check*.test.js` for all shells; add cases for installed, not installed, and pinned.

## 3. Run the PowerShell containers as non-root on Windows (#98)

Today: `_Safe_Pkg_User` (`assets/_safe_pkg_shared.ps1:731`) returns no `--user` flag on Windows, so the containers run as root there.

Steps:
- Windows has no uid to pass. Use a fixed non-root uid:gid (the image's `node` user, 1000:1000, or a dedicated one) with `HOME=/app/.safe-home`, as on macOS and Linux.
- Check that Docker Desktop's bind mounts on Windows let that uid write `/app` and the copy-back. If they don't, this needs a different approach; stop and decide before coding.
- Tests: behavioral tests in the existing ps1 suites, which run on the `windows-latest` CI job (`.github/workflows/ci.yml:33`). That runner cannot run Linux containers, so the real-daemon check is a manual run on a Windows machine, recorded in the PR.
- Update the README line that says Windows still runs as root.

## 4. Test rootless Docker and Podman against a real daemon (#99)

Today: `_safe_pkg_docker_rootless` (`assets/_safe_pkg_shared.sh:818`) and its ps1 twin are tested only with a stubbed `docker info`. The README says this is untested on a real daemon.

Steps:
- Add a CI job on `ubuntu-latest` that runs one install through the wrapper under Podman rootless (Podman ships on the runner image; alias or shim `docker` to it). Check: the detection fires, no `--user` is passed, and the copied-back files are owned by the runner user.
- Add the same for rootless Docker if it can be set up on the runner in reasonable time (`dockerd-rootless-setuptool.sh`); otherwise do it by hand once and record it in the PR.
- Remove "not tested against a real rootless daemon" from the README once the job is green.

## Order and done

Order: #97, #100, #98, #99 (smallest and most self-contained first; #98 and #99 may need manual daemon runs). Done when all four issues are closed, `npm test` and `npm run lint` pass, and a release PR carries the M5 roadmap tick.
