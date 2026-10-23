# M5 — Known gaps from M4

Date: 2026-10-22. Tracked as issue #103; the roadmap no longer lists M5 (PR #104).

M5's two original sub-items (OSV checks for npx/dlx/create in fish, #60, and PowerShell, #61) are done. What is left is the four gaps moved to issues on 2026-10-21. Each one lands as its own PR off `main`, tests first, in all three shell families (sh/zsh/bash in `_safe_pkg_shared.sh`, fish in `_safe_pkg_prescan.fish`, PowerShell in `_safe_pkg_shared.ps1`). A gap may also be closed as a documented limitation, with the reason recorded in its issue.

## 1. Refuse unpinned npx of a command the project doesn't install (#100)

Today: `_safe_pkg_runner_tail` (`assets/_safe_pkg_shared.sh:234`) returns the bare command word as the spec, and `malware-scan.js --specs` resolves it with `npm view` to the current version. For `npx tsc` with no local `tsc`, npx downloads the placeholder package `tsc@2.0.4`, which OSV knows nothing useful about, so the scan passes without saying anything.

Steps:
- Decide what "installed" means: the command is in `node_modules/.bin` of the working directory or a parent (how npx itself looks it up). Confirm against npm 10 and 11 before writing the check.
- When the spec has no version and the command is not installed, refuse with a message that says to name a version (`npx tsc@5.6.3`) or to install it. A spec with a version, tag or range still goes to OSV as now.
- Scope: exec mode only (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`). `create` always fetches a named package, so it is out of scope.
- `--package NAME` without a version counts as unpinned too (same scan-the-latest case); confirm in the PR.
- Put the rule in one place if possible (`malware-scan.js --specs` gets the cwd) so the three shells don't each grow a copy.
- Tests: `test/helpers/runner-cases.js` feeds `runner-check.test.js`, `runner-check-fish.test.js` and `ps1-runner-check.test.js`. Cases: not installed (refused), installed, pinned, `--package typescript@5.6.3 tsc`.
- Document in the README npx section and `docs/security.md:33`.

## 2. Copy `.yarnrc.yml` into the audit directory (#97)

Finding: this gap only exists once Yarn Berry (v2+) is supported. The yarn wrappers are Yarn 1 only (`assets/yarn-wrapper.sh:12`), they never copy `.yarnrc.yml` into the sandbox (`assets/yarn-wrapper.sh:23`, `yarn-wrapper.fish:166`, `yarn-wrapper.ps1`), and `malware-scan.js:143` refuses a Berry lockfile (`__metadata:`). npm and pnpm don't read `.yarnrc.yml`.

Steps:
- Confirm with a test in each shell that a Berry project is refused before the audit step. If so, close #97 as blocked on Berry support, and open Berry support as its own roadmap feature.
- If some path does reach the audit with a `.yarnrc.yml`: copy it next to `.yarnrc` in `_safe_pkg_audit` (`_safe_pkg_shared.sh:353`, `_safe_pkg_shared.ps1:107`, `_safe_pkg_prescan.fish:35`), dropping `yarnPath` and `plugins` (both run project code on the host) and stripping auth lines with the existing helper (`_safe_pkg_shared.sh:778`). Berry's audit command is `yarn npm audit`, not `yarn audit`.

## 3. Run the PowerShell containers as non-root on Windows (#98)

Today: `_Safe_Pkg_User` (`assets/_safe_pkg_shared.ps1:731`) returns no `--user` flag on Windows, so the containers run as root there. Windows has no uid to pass.

Steps:
- Probe by hand on Docker Desktop for Windows (WSL2 backend): can `--user 1000:1000` (the image's `node` user) write a bind-mounted `C:\...` temp dir, and does the copied-back `node_modules` stay usable by the Windows user? Record the output in the issue.
- If yes: return `@('--user', '1000:1000', '-e', 'HOME=/app/.safe-home')` on Windows, test-first in the ps1 suites with a stubbed `$IsWindows`. The `windows-latest` CI job (`.github/workflows/ci.yml:33`) can't run Linux containers, so the PR records the manual run. If no: close #98 as a documented limitation.
- Update the Windows sentence in `docs/security.md:38` and the README.

## 4. Test rootless Docker and Podman against a real daemon (#99)

Today: `_safe_pkg_docker_rootless` (`assets/_safe_pkg_shared.sh:818`) and its ps1 twin are tested only with a stubbed `docker info`; README:45 says so.

Steps:
- Add a separate CI job on `ubuntu-latest`, so a daemon setup failure doesn't hide unit-test results. Podman (preinstalled, rootless) through a `docker` shim, and rootless Docker via `dockerd-rootless-setuptool.sh`. Each runs one real `pnpm install` and one `npm ci` through the wrappers on a small fixture and checks that detection fires, no `--user` is passed, and the copied-back `node_modules` is owned by the runner user.
- Make the job required once it has passed on `main` twice.
- Remove "not tested against a real rootless daemon" from README:45 once green.

## Order and done

Order: #100 (security, smallest), #97 (likely closes as blocked), #98, #99. Done when all four issues are closed, fixed or with the reason recorded, `npm test` and `npm run lint` pass, and a release PR ships the fixes. Then close #103.
