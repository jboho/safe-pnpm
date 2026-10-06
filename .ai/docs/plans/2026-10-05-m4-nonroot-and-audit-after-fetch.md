# safe-pnpm M4: Non-root Containers and CVE Audit After the Fetch — Implementation Plan

> **Execution:** hand off to the `run-plan` skill to implement this task-by-task (fresh subagent per task + spec/quality review). Steps use `- [ ]` checkboxes for tracking.

**Goal:** Close the two open ROADMAP M4 items. (A) Both install containers run as the invoking host user instead of root. (B) The CVE audit moves from before the fetch to after it, so it covers packages passed to `add`.

**Architecture:** Two PRs, merged in order.
- **PR A (`feat/m4-nonroot`):** adds `--user UID:GID -e HOME=/app/.safe-home` to both `docker run` calls in every wrapper. The flag lives in `_safe_pkg_shared.sh` for bash/zsh, in the three fish wrappers, and in a new `_Safe_Pkg_User` helper in `_safe_pkg_shared.ps1`. On Windows the helper returns no flags.
- **PR B (`feat/m4-audit-after-fetch`, branched from main after PR A merges):** removes the audit from the prescan and adds an `_safe_pkg_audit` step (sh, fish, ps1). It runs on the host after the fetch, the malware scan and the manifest snapshot, and before the build container. It audits a throwaway copy of the snapshot plus the project's registry config, never the project itself. pnpm also gets `--config.ignore-pnpmfile=true`, so a project `.pnpmfile.cjs` never runs on the host.

**Tech stack:** POSIX sh (bash + zsh), fish, PowerShell 7, Docker, Node `node:test`. Lint: oxlint + biome.

**Decisions already made (do not revisit):**
- Option C for non-root: `--user $(id -u):$(id -g)` with `HOME=/app/.safe-home`. Not a `USER` line in the Dockerfile: a fixed uid in the image would not match the host user, and the files it creates in the bind mount would not be deletable on Linux.
- Option B for the audit: host-side, after the fetch, in a clean dir.
- Windows PowerShell keeps running containers as root (no uid to pass). This is documented as a known gap.

**Probes already run (2026-10-05, this Mac, Docker Desktop):**
- `--user 501:20 -e HOME=/app/.safe-home` with the real image: phase 1 (`install --ignore-scripts`) and phase 2 (offline build, `--network none`) exit 0 for npm, pnpm and yarn, and each writes its lockfile.
- Task 1's test, run unchanged against the current assets (2026-10-05): all 3 managers exit 0, copy the lockfile back and run 2 containers; each fails only on the missing `--user`. So the harness is sound, and Docker works with HOME moved because the test sets `DOCKER_CONFIG`.
- The npm PowerShell wrapper, run in the `safe-pnpm-pwsh-test` container with a stub `docker`, gives `RC=0`, two runs and a copied-back `node_modules`. Linux pwsh resolves its `\` paths.
- `pnpm audit --ignore-pnpmfile` is not a valid flag. The working form is `--config.ignore-pnpmfile=true`.

**Out of scope:** version bump, release, CHANGELOG (the repo has none). Publishing is the user's call.

**Human gates:** run-plan stops at each one.
- Task 5 Step 4: the user reviews PR A, then gives the go to push and open it. The user merges it.
- Task 6 Step 1: PR A must be merged before PR B branches from main.
- Task 11 Step 4: the user reviews PR B, then gives the go to push and open it. The user merges it.

---

## Conventions for every task

- Repo worktrees:
  - PR A: `/Users/jboho/Code/.worktrees/safe-pnpm-m4`, branch `feat/m4-nonroot`, no upstream set.
  - PR B: `/Users/jboho/Code/.worktrees/safe-pnpm-m4-audit`, created in Task 6.
- Run commands from the worktree root. Paths below are relative to it.
- **Tests:** run `node --test ...` directly, never `npm test`. `npm` in this shell is a safe-pnpm wrapper function that fails without an interactive shell.
- **Verbose commands:** `CMD > FILE 2>&1; echo "exit=$?"`. Take the verdict from the `exit=` line. Use a new file name each run, in the session scratchpad.
  - Never pipe the command through `tail` or `grep`.
  - On failure, read `tail -100 FILE`.
- **Lint:** `node_modules` was installed by safe-pnpm inside a Linux container, so the native lint binaries are Linux builds. Run lint in a matching container (Task 0 shows the command).
- **Commits:** no `Co-authored-by` or tool attribution. Never `git push` without the user's go.
- **Docs:** match the quoted old text, not line numbers. Line numbers are from the plan's snapshot and can shift.
- **ROADMAP.md:** koll keys items by a hash of the line text. Only change `[ ]` to `[x]`; never edit an item's words.

## File map

| File | PR | Change |
|---|---|---|
| `assets/_safe_pkg_shared.sh` | A | `user_flags` in `_safe_pkg_sandbox`, passed to both runs |
| `assets/{npm,pnpm,yarn}-wrapper.fish` | A | `user_flags`, passed to both runs |
| `assets/_safe_pkg_shared.ps1` | A | new `_Safe_Pkg_User` |
| `assets/{npm,pnpm,yarn}-wrapper.ps1` | A | `(_Safe_Pkg_User)` in `$p1` and `$p2` |
| `test/image-e2e.test.js` | A | new: real install through the bash wrappers against the real image |
| `test/helpers/pwsh-image.js` | A | new: pwsh test image, shared by both ps1 test files |
| `test/ps1-copy-back.test.js` | A | uses the helper |
| `test/ps1-wrappers.test.js` | A (B extends) | new: whole-wrapper ps1 runs with a stub docker |
| `test/two-phase.test.js` | A (B extends) | `--user` test; B adds audit stubs and audit tests |
| `README.md`, `docs/security.md`, `CONTRIBUTING.md`, `ROADMAP.md` | A and B | docs |
| `assets/_safe_pkg_prescan.fish` | B | audit removed from prescan; new `_safe_pkg_audit` |
| `assets/_safe_pkg_shared.sh`, `assets/*-wrapper.fish`, `assets/_safe_pkg_shared.ps1`, `assets/*-wrapper.ps1` | B | audit after the snapshot |
| `test/hardening.test.js`, `test/hardening-fish.test.js` | B | audit tests now expect a block after the fetch |
| `test/socket.test.js` | B | one comment |
| `docs/socket.md` | B | docs |

---

# PR A — Non-root containers

### Task 0: Prepare the worktree and record a baseline

No test to write; this is setup.

**Files:** none changed.

- [ ] **Step 1: Confirm the worktree is clean and current**

```bash
cd /Users/jboho/Code/.worktrees/safe-pnpm-m4
git fetch origin
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

Expected:
- `## feat/m4-nonroot` with no changed files.
- The two shas are equal.
- If `origin/main` moved, stop and report. Don't rebase without asking.

- [ ] **Step 2: Install dev dependencies through safe-pnpm**

Docker must be running.

```bash
zsh -ic 'cd /Users/jboho/Code/.worktrees/safe-pnpm-m4 && npm ci' > SCRATCH/t0-install.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Baseline test run**

```bash
node --test test/*.test.js > SCRATCH/t0-test.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t0-test.log
```

Expected:
- `exit=0`, `# fail 0`.
- Record the `# tests` and `# skipped` counts. Later tasks compare against them.
- CI on main reported 223 tests. Locally the count can differ when zsh or fish is missing.

- [ ] **Step 4: Baseline lint in a container**

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-alpine sh -c 'npm run lint' > SCRATCH/t0-lint.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

If it fails with a missing native binary (`Cannot find module @oxlint/...` or `@biomejs/cli-...`), report that. Lint then runs only in CI, and the PR body must say so.

---

### Task 1: End-to-end test against the real image (red)

**Files:**
- Create: `test/image-e2e.test.js`

This is the only test that runs the real image. It proves two things:
- The image works with `--user`.
- On Linux, the host can delete the sandbox afterwards. A root container leaves root-owned files there that the host user can't remove.

- [ ] **Step 1: Write the test**

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");
const IMAGE = "safe-pnpm-e2e-test";
const LOCKFILES = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

const hasDocker =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const skip = hasDocker ? false : "docker not available";
const realDocker = spawnSync("sh", ["-c", "command -v docker"], {
  encoding: "utf8",
}).stdout.trim();

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-e2e-"));
  if (!hasDocker) return;
  const b = spawnSync("docker", ["build", "-q", "-t", IMAGE, ASSETS_DIR], {
    encoding: "utf8",
  });
  assert.equal(b.status, 0, b.stderr);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs `<manager> install` through the bash wrapper against the image built
// from assets/Dockerfile. A shim in front of docker swaps the image tag for the
// test build and logs each `docker run`, so the test sees the exact flags the
// wrapper passed. The project has no dependencies, so nothing is downloaded.
function install(manager) {
  const root = fs.mkdtempSync(path.join(tmp, `${manager}-`));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  for (const d of [bin, proj, path.join(home, ".safe-pnpm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.copyFileSync(
    path.join(ASSETS_DIR, "link-check.js"),
    path.join(home, ".safe-pnpm", "link-check.js"),
  );
  const log = path.join(root, "docker-runs.log");
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      `for a in "$@"; do shift; [ "$a" = safe-pnpm:latest ] && a=${IMAGE}; set -- "$@" "$a"; done`,
      `[ "$1" = run ] && echo "$@" >> "${log}"`,
      `exec "${realDocker}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The host's own npm/pnpm/yarn would query the registry; these stubs keep
  // the run offline apart from the container fetch.
  for (const m of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(path.join(bin, m), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "e2e", version: "1.0.0", private: true }),
  );
  const script = `source "${ASSETS_DIR}/_safe_pkg_shared.sh"; source "${ASSETS_DIR}/${manager}-wrapper.sh"; cd "${proj}"; ${manager} install </dev/null`;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      // HOME moved, so point the docker CLI back at the real context config.
      DOCKER_CONFIG:
        process.env.DOCKER_CONFIG ?? path.join(os.homedir(), ".docker"),
      NPM_TOKEN: "",
      NODE_AUTH_TOKEN: "",
      SAFE_PNPM_STRICT: "",
      SAFE_PNPM_OSV_STRICT: "",
    },
  });
  const runs = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n")
    : [];
  return { r, proj, runs };
}

for (const manager of ["npm", "pnpm", "yarn"]) {
  test(`${manager}: a real install runs both containers as the host user`, { skip }, () => {
    const { r, proj, runs } = install(manager);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      fs.existsSync(path.join(proj, LOCKFILES[manager])),
      "lockfile copied back",
    );
    assert.equal(runs.length, 2, "fetch and build phases both ran");
    const user = `--user ${process.getuid()}:${process.getgid()}`;
    for (const line of runs) {
      assert.ok(line.includes(user), `expected ${user} in: ${line}`);
      assert.match(line, /-e HOME=\/app\/\.safe-home/);
    }
    // On Linux a root container leaves root-owned files the host user cannot
    // delete, so the sandbox would outlive the install.
    const sandbox = runs[0].match(/-v (\S+):\/app/)[1];
    assert.equal(fs.existsSync(sandbox), false, "sandbox removed");
  });
}
```

- [ ] **Step 2: Run it, verify it fails**

```bash
node --test test/image-e2e.test.js > SCRATCH/t1-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail)' SCRATCH/t1-red.log
```

Expected:
- `exit=1`, `# fail 3`.
- Each failure message is `expected --user UID:GID in: run --rm ...`.
- If any failure is about `r.status` or the lockfile instead, stop and report. The harness is wrong, not the wrapper.

- [ ] **Step 3: Commit the red test**

```bash
git add test/image-e2e.test.js
git commit -m "test: end-to-end install against the real image, expecting host-user containers"
```

---

### Task 2: bash/zsh and fish run both containers as the host user

**Files:**
- Modify: `assets/_safe_pkg_shared.sh` (in `_safe_pkg_sandbox`: after the `hardening` lines, about 367-368; Phase 1 run at about 378; Phase 2 run at about 431)
- Modify: `assets/npm-wrapper.fish`, `assets/yarn-wrapper.fish` (after the `SAFE_PNPM_MEMORY` block, about 77-79; runs at about 82 and 116)
- Modify: `assets/pnpm-wrapper.fish` (after the `SAFE_PNPM_MEMORY` block, about 105-107; runs at about 110 and 153)
- Test: `test/two-phase.test.js` (append at end of file)

- [ ] **Step 1: Write the failing test**

Append to `test/two-phase.test.js`:

```js
for (const { shell, ext, available } of SHELLS) {
  for (const manager of ["npm", "pnpm", "yarn"]) {
    test(`${manager} (${shell}): both containers run as the host user`, { skip: !available }, () => {
      const { read, runCount } = runWrapper(manager, `${manager}-wrapper.${ext}`, { shell });
      assert.equal(runCount, 2);
      const user = `--user ${process.getuid()}:${process.getgid()}`;
      for (const n of [1, 2]) {
        const args = read(`run${n}.args`);
        assert.ok(args.includes(user), `run ${n} must pass ${user}`);
        assert.match(args, /-e HOME=\/app\/\.safe-home/);
      }
    });
  }
}
```

- [ ] **Step 2: Run it, verify it fails**

```bash
node --test --test-name-pattern='host user' test/two-phase.test.js > SCRATCH/t2-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail|skipped)' SCRATCH/t2-red.log
```

Expected:
- `exit=1`.
- `# fail` equals 9 minus the skipped count: 3 managers times 3 shells, with missing shells skipped.
- Each message is `run 1 must pass --user ...`.

- [ ] **Step 3: Implement in `assets/_safe_pkg_shared.sh`**

Insert directly after the line `[ -n "${SAFE_PNPM_MEMORY:-}" ] && hardening="$hardening --memory ${SAFE_PNPM_MEMORY}"`:

```sh

  # Both containers run as the invoking user, not root. Files they create in
  # the sandbox are then owned by that user, so cleanup can delete them on
  # Linux (Docker Desktop on macOS hides root ownership), and a process that
  # escapes the container is an ordinary user. The image has no home dir for
  # an arbitrary uid, so HOME points inside the sandbox mount.
  local user_flags="--user $(id -u):$(id -g) -e HOME=/app/.safe-home"
```

Change the Phase 1 line `docker run --rm --cap-drop ALL $hardening \` to:

```sh
  docker run --rm --cap-drop ALL $hardening $user_flags \
```

Change the Phase 2 line `docker run --rm --cap-drop ALL $hardening $net_flag \` to:

```sh
    docker run --rm --cap-drop ALL $hardening $user_flags $net_flag \
```

`$user_flags` stays unquoted on purpose: it must split into four words. zsh splits it because `_safe_pkg_sandbox` sets `sh_word_split`.

- [ ] **Step 4: Implement in the three fish wrappers**

In each of `assets/npm-wrapper.fish`, `assets/yarn-wrapper.fish` and `assets/pnpm-wrapper.fish`, insert directly after the `end` that closes `if test -n "$SAFE_PNPM_MEMORY"`:

```fish

    # Both containers run as the invoking user, not root. Files they create in
    # the sandbox are then owned by that user, so cleanup can delete them on
    # Linux (Docker Desktop on macOS hides root ownership), and a process that
    # escapes the container is an ordinary user. The image has no home dir for
    # an arbitrary uid, so HOME points inside the sandbox mount.
    set -l user_flags --user (id -u):(id -g) -e HOME=/app/.safe-home
```

In the same three files, change both `docker run` lines:
- `docker run --rm --cap-drop ALL $hardening -v "$tmpdir:/app"` becomes `docker run --rm --cap-drop ALL $hardening $user_flags -v "$tmpdir:/app"` (Phase 1).
- `docker run --rm --cap-drop ALL $hardening $net_flag -v "$tmpdir:/app"` becomes `docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app"` (Phase 2).

Leave the rest of each line (`-w ...`, `$token_env`, the trailing `\`) unchanged.

- [ ] **Step 5: Run the new tests and the e2e test, verify they pass**

```bash
node --test --test-name-pattern='host user' test/two-phase.test.js > SCRATCH/t2-green.log 2>&1; echo "exit=$?"
node --test test/image-e2e.test.js > SCRATCH/t2-e2e.log 2>&1; echo "exit=$?"
```

Expected:
- Both `exit=0`.
- The two-phase run has `# fail 0`.
- The e2e run has `# pass 3`.

- [ ] **Step 6: Run the full suite**

```bash
node --test test/*.test.js > SCRATCH/t2-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t2-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = the Task 0 baseline + 12 (9 two-phase, 3 e2e).

- [ ] **Step 7: Commit**

```bash
git add assets/_safe_pkg_shared.sh assets/npm-wrapper.fish assets/yarn-wrapper.fish assets/pnpm-wrapper.fish test/two-phase.test.js
git commit -m "fix: run sh and fish install containers as the host user, not root"
```

---

### Task 3: PowerShell runs both containers as the host user

**Files:**
- Create: `test/helpers/pwsh-image.js`
- Modify: `test/ps1-copy-back.test.js:1-28` (use the helper)
- Create: `test/ps1-wrappers.test.js`
- Modify: `assets/_safe_pkg_shared.ps1` (after `_Safe_Pkg_Hardening`, about line 161)
- Modify: `assets/npm-wrapper.ps1:56,77`, `assets/yarn-wrapper.ps1:57,78`, `assets/pnpm-wrapper.ps1:87,110`

- [ ] **Step 1: Move the pwsh image setup into a helper**

Create `test/helpers/pwsh-image.js`:

```js
const { spawnSync } = require("node:child_process");

const IMAGE = "safe-pnpm-pwsh-test";
// The powershell image is amd64-only, so the node binary must match.
const DOCKERFILE = [
  "FROM --platform=linux/amd64 mcr.microsoft.com/powershell:lts-debian-12",
  "COPY --from=docker.io/library/node:22 /usr/local/bin/node /usr/local/bin/node",
].join("\n");

const hasDocker =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

function buildPwshImage() {
  const b = spawnSync(
    "docker",
    ["build", "-q", "--platform", "linux/amd64", "-t", IMAGE, "-"],
    { input: DOCKERFILE, encoding: "utf8" },
  );
  if (b.status !== 0) throw new Error(`pwsh image build failed: ${b.stderr}`);
}

module.exports = { IMAGE, hasDocker, buildPwshImage };
```

In `test/ps1-copy-back.test.js`, replace lines 1-28 (the imports down to the end of the `before(...)` block) with:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1-"));
  if (hasDocker) buildPwshImage();
});
```

Leave the rest of the file unchanged.

```bash
node --test test/ps1-copy-back.test.js > SCRATCH/t3-copyback.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`, `# pass 6`. This step is a pure refactor.

- [ ] **Step 2: Write the failing wrapper tests**

Create `test/ps1-wrappers.test.js`:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";
const LOCKFILES = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1w-"));
  if (hasDocker) buildPwshImage();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs `<manager> install` through the PowerShell wrapper in a Linux pwsh
// container, with the host dir `root` mounted at /w. A stub `docker` in /w/bin
// logs each run's argv to /w/docker.log and, on the first run, writes a
// node_modules and a lockfile into the sandbox the way a real fetch would.
function runPs1(manager, { env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, `${manager}-`));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const safe = path.join(root, "home", ".safe-pnpm");
  for (const d of [bin, proj, safe]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["_safe_pkg_shared.ps1", `${manager}-wrapper.ps1`, "link-check.js"]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      '[ "$1" = info ] && exit 0',
      'echo "$@" >> /w/docker.log',
      'src=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && src="${a%%:/app}"; prev="$a"; done',
      "n=$(grep -c '' /w/docker.log)",
      `if [ "$n" = 1 ]; then mkdir -p "$src/node_modules/dep"; echo x > "$src/node_modules/dep/index.js"; echo resolved-by-phase-1 > "$src/${LOCKFILES[manager]}"; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(proj, ".npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const script = `$env:PATH = '/w/bin:' + $env:PATH; . "$HOME/.safe-pnpm/${manager}-wrapper.ps1"; Set-Location /w/proj; ${manager} install; "RC=$LASTEXITCODE"`;
  const r = spawnSync(
    "docker",
    [
      "run", "--rm", "--platform", "linux/amd64",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "HOME=/w/home", ...envArgs,
      "-v", `${root}:/w`,
      IMAGE, "pwsh", "-NoProfile", "-Command", script,
    ],
    { encoding: "utf8" },
  );
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      return "";
    }
  };
  const runs = read("docker.log")
    .split("\n")
    .filter((l) => l.startsWith("run"));
  return { root, proj, safe, bin, out: r.stdout + r.stderr, runs, read };
}

for (const manager of ["npm", "pnpm", "yarn"]) {
  test(`ps1 ${manager}: both containers run as the host user`, { skip }, () => {
    const { out, runs, proj } = runPs1(manager);
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    const user = `--user ${process.getuid()}:${process.getgid()}`;
    for (const line of runs) {
      assert.ok(line.includes(user), `expected ${user} in: ${line}`);
      assert.match(line, /-e HOME=\/app\/\.safe-home/);
    }
    assert.ok(
      fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")),
      "copy-back ran",
    );
  });
}

// Windows has no uid to pass, so the helper returns nothing there and the
// containers keep running as root (a documented gap).
test("ps1: _Safe_Pkg_User passes no --user on Windows", { skip }, () => {
  const r = spawnSync(
    "docker",
    [
      "run", "--rm", "--platform", "linux/amd64",
      "-v", `${ASSETS}:/assets:ro`,
      IMAGE, "pwsh", "-NoProfile", "-Command",
      `. /assets/_safe_pkg_shared.ps1; "UNIX=" + @(_Safe_Pkg_User).Count; $env:OS = 'Windows_NT'; "WIN=" + @(_Safe_Pkg_User).Count`,
    ],
    { encoding: "utf8" },
  );
  assert.match(r.stdout, /UNIX=4/, r.stdout + r.stderr);
  assert.match(r.stdout, /WIN=0/, r.stdout + r.stderr);
});
```

- [ ] **Step 3: Run it, verify it fails**

```bash
node --test test/ps1-wrappers.test.js > SCRATCH/t3-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail)' SCRATCH/t3-red.log
```

Expected:
- `exit=1`, `# fail 4`.
- The three wrapper tests fail on `expected --user ...`.
- The Windows test fails because `_Safe_Pkg_User` is not defined: the output shows `UNIX=0` or a "not recognized" error.
- If a wrapper test fails on `RC=0` or `runs.length`, stop and report. The harness is wrong.

- [ ] **Step 4: Add `_Safe_Pkg_User` to `assets/_safe_pkg_shared.ps1`**

Insert directly after the closing `}` of `function _Safe_Pkg_Hardening`:

```powershell

# Both containers run as the invoking user, not root (see _safe_pkg_shared.sh).
# Windows has no uid to pass, so there they still run as root.
function _Safe_Pkg_User {
    if ($IsWindows -or $env:OS -eq 'Windows_NT') { return @() }
    return @('--user', "$(id -u):$(id -g)", '-e', 'HOME=/app/.safe-home')
}
```

`$IsWindows` does not exist in Windows PowerShell 5.1, so the `$env:OS` check covers it there.

- [ ] **Step 5: Use it in all three ps1 wrappers**

In each of `assets/npm-wrapper.ps1`, `assets/yarn-wrapper.ps1` and `assets/pnpm-wrapper.ps1`:
- In the `$p1 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + @('-v',...` line, change `+ (_Safe_Pkg_Hardening) +` to `+ (_Safe_Pkg_Hardening) + (_Safe_Pkg_User) +`.
- In the `$p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $netFlag +` line, change it to `$p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + (_Safe_Pkg_User) + $netFlag +`.

Each file has exactly two such lines. Verify with:

```bash
grep -c '(_Safe_Pkg_Hardening) + (_Safe_Pkg_User)' assets/npm-wrapper.ps1 assets/yarn-wrapper.ps1 assets/pnpm-wrapper.ps1
```

Expected: `2` for each file.

- [ ] **Step 6: Run the ps1 tests, verify they pass**

```bash
node --test test/ps1-wrappers.test.js test/ps1-copy-back.test.js > SCRATCH/t3-green.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail)' SCRATCH/t3-green.log
```

Expected: `exit=0`, `# pass 10`, `# fail 0`.

- [ ] **Step 7: Full suite**

```bash
node --test test/*.test.js > SCRATCH/t3-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t3-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = baseline + 16.

- [ ] **Step 8: Commit**

```bash
git add test/helpers/pwsh-image.js test/ps1-copy-back.test.js test/ps1-wrappers.test.js assets/_safe_pkg_shared.ps1 assets/npm-wrapper.ps1 assets/yarn-wrapper.ps1 assets/pnpm-wrapper.ps1
git commit -m "fix: run PowerShell install containers as the host user outside Windows"
```

---

### Task 4: Docs for non-root containers

No test; docs only.

**Files:**
- Modify: `docs/security.md` (about lines 16 and 35)
- Modify: `README.md` (about lines 44, 46, 117)
- Modify: `CONTRIBUTING.md` (the "Coverage falls into three groups" list, about line 26)
- Modify: `ROADMAP.md` (about line 17)

- [ ] **Step 1: `docs/security.md`**

In the paragraph starting "Inside the Docker container, none of this is reachable:", replace

`and all Linux capabilities are dropped, with \`no-new-privileges\` and a process limit set.`

with

`the container runs as your own user rather than root, all Linux capabilities are dropped, and \`no-new-privileges\` and a process limit are set.`

In the "Container escape exploits" row, replace

`The container still runs as root inside its own namespace, with no memory limit unless \`SAFE_PNPM_MEMORY\` is set.`

with

`Both containers run as your user (\`--user\` with your uid and gid), not root; on Windows the PowerShell wrappers still run them as root, because Windows has no uid to pass. No memory limit unless \`SAFE_PNPM_MEMORY\` is set.`

- [ ] **Step 2: `README.md`**

Replace

`- The containers run as root inside Docker (\`--cap-drop ALL\` and \`no-new-privileges\` apply; no \`USER\` is set yet).`

with

`- On Windows the PowerShell wrappers still run the containers as root inside Docker (\`--cap-drop ALL\` and \`no-new-privileges\` apply). macOS and Linux run them as your user.`

Replace

`- PowerShell is the least-tested shell: copy-back and its link check are tested on Linux pwsh only, and the wrapper files have parse tests only.`

with

`- PowerShell is the least-tested shell: the wrappers and copy-back are tested on Linux pwsh only.`

Replace

`3. **Fetch in Docker** — ephemeral container, \`--cap-drop ALL\`, \`--ignore-scripts\`.`

with

`3. **Fetch in Docker** — ephemeral container running as your user, \`--cap-drop ALL\`, \`--ignore-scripts\`.`

Keep the rest of that line.

- [ ] **Step 3: `CONTRIBUTING.md`**

Insert this bullet directly after the "**Link check**" bullet:

```markdown
- **Docker image and PowerShell** — `image-e2e.test.js` runs a real install through the bash wrappers against an image built from `assets/Dockerfile`. `ps1-wrappers.test.js` and `ps1-copy-back.test.js` run the PowerShell code in a Linux pwsh container (`test/helpers/pwsh-image.js`), with a stub `docker` for the wrappers. All three skip when Docker is not running.
```

Also change "Coverage falls into three groups:" to "Coverage falls into these groups:". The list already has more than three.

- [ ] **Step 4: `ROADMAP.md`**

On the line `  - [ ] Run the containers as a non-root user (no \`USER\` in \`assets/Dockerfile\` today; see docs/security.md)`, change only `[ ]` to `[x]`. Leave the text unchanged.

- [ ] **Step 5: Check, then commit**

```bash
git diff --stat
grep -n 'runs as root\|no `USER` is set' README.md docs/security.md; s=$?; [ $s -eq 1 ] && echo none; [ $s -gt 1 ] && echo "grep error $s"
```

Expected:
- The diff touches 4 files.
- The grep prints `none`.

```bash
git add docs/security.md README.md CONTRIBUTING.md ROADMAP.md
git commit -m "docs: containers run as the host user; Windows root gap; new test files"
```

---

### Task 5: Verify PR A and open it on the user's go

- [ ] **Step 1: Full suite**

```bash
node --test test/*.test.js > SCRATCH/t5-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t5-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = baseline + 16.

- [ ] **Step 2: Lint**

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-alpine sh -c 'npm run lint' > SCRATCH/t5-lint.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. If Task 0 found that lint can't run locally, write "lint not run locally; CI runs it" in the PR body.

- [ ] **Step 3: Review the branch diff**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected:
- 4 commits.
- Only files from the PR A rows of the file map.

- [ ] **Step 4: STOP — human gate**

Show the user the commit list and diff stat, and ask: "Push `feat/m4-nonroot` and open a PR into `main`? Merging it makes every container run as your user on macOS and Linux." Do not push until the user says yes.

- [ ] **Step 5: Push and open the PR (after the yes)**

```bash
git push origin HEAD:refs/heads/feat/m4-nonroot
gh pr create --repo jboho/safe-pnpm --base main --head feat/m4-nonroot --title "fix: run install containers as the host user, not root" --body-file SCRATCH/pr-a-body.md
```

Write `SCRATCH/pr-a-body.md` first with the Write tool. It has three parts:
- **What changes:** both containers get `--user UID:GID -e HOME=/app/.safe-home` in sh/zsh, fish and PowerShell (outside Windows).
- **Why:** on Linux, root-owned sandbox files couldn't be deleted by the host user, and a container escape would land as root.
- **Tests:** new `image-e2e.test.js` (real image), `ps1-wrappers.test.js`, and the two-phase `--user` test. Give the local pass/skip counts from Step 1, and the lint result.

Then wait for CI and give the user the run id and result. The user merges.

---

# PR B — CVE audit after the fetch

### Task 6: New worktree from main after PR A merges

- [ ] **Step 1: STOP — confirm PR A is merged**

```bash
gh pr list --repo jboho/safe-pnpm --head feat/m4-nonroot --state merged --json number,mergeCommit
```

Expected: one entry. If it's empty, stop and tell the user PR B waits on PR A.

- [ ] **Step 2: Create the worktree with no upstream**

```bash
git -C /Users/jboho/Code/.worktrees/safe-pnpm-m4 fetch origin
git -C /Users/jboho/Code/.worktrees/safe-pnpm-m4 worktree add --no-track -b feat/m4-audit-after-fetch /Users/jboho/Code/.worktrees/safe-pnpm-m4-audit origin/main
cd /Users/jboho/Code/.worktrees/safe-pnpm-m4-audit
git log --oneline -1
grep -c 'user_flags' assets/_safe_pkg_shared.sh
```

Expected:
- HEAD is PR A's squash commit.
- The grep prints `3` (the definition plus two uses).

`--no-track` matters: without it, the new branch tracks `origin/main`, and a bare `git push` would target main.

- [ ] **Step 3: Install deps and record a baseline**

```bash
zsh -ic 'cd /Users/jboho/Code/.worktrees/safe-pnpm-m4-audit && npm ci' > SCRATCH/t6-install.log 2>&1; echo "exit=$?"
node --test test/*.test.js > SCRATCH/t6-test.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t6-test.log
```

Expected:
- Both `exit=0`, `# fail 0`.
- Record the counts as the PR B baseline.

All later PR B paths are relative to `/Users/jboho/Code/.worktrees/safe-pnpm-m4-audit`.

---

### Task 7: bash/zsh audit after the fetch

**Files:**
- Modify: `test/two-phase.test.js` (`runWrapper` options comment, proj setup, stubs, env; new tests at end)
- Modify: `test/hardening.test.js` (sandbox, `RUN`, the two audit tests)
- Modify: `test/socket.test.js:154-156` (comment)
- Modify: `assets/_safe_pkg_shared.sh` (`_safe_pkg_prescan` lines 6-57; new `_safe_pkg_audit`; call site in `_safe_pkg_sandbox` after the snapshot)

- [ ] **Step 1: Extend the two-phase harness**

In `test/two-phase.test.js`, add these two lines to the options comment above `function runWrapper`, after the `opts.noLinkCheck` line:

```js
// opts.auditRc   — exit code of the host-side `<manager> audit` stub (default 0)
// opts.strict    — set SAFE_PNPM_STRICT=1
```

After the `.npmrc` `fs.writeFileSync(...)` block and before `if (opts.workspace)`, add:

```js
  // A pnpmfile runs host code when pnpm loads it, so the audit must never see
  // one. Written for every manager; only pnpm would load it.
  fs.writeFileSync(path.join(proj, ".pnpmfile.cjs"), "module.exports = {};\n");
```

After `fs.chmodSync(dockerPath, 0o755);`, add:

```js
  // Host-side audit stubs. Each call records where it ran, its arguments, the
  // files it could see, the lockfile it read, and how many docker runs had
  // happened by then.
  for (const m of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(
      path.join(bin, m),
      `#!/bin/sh\n{ echo "CWD=$(pwd)"; echo "ARGS=$*"; echo "FILES=$(ls -A | tr '\\n' ' ')"; echo "LOCK=$(cat ${lockfile} 2>/dev/null)"; echo "RUNS=$(cat ${log}/count)"; } >> "${log}/audit.log"\necho "audit-stub: 1 high severity vulnerability"\nexit ${opts.auditRc ?? 0}\n`,
      { mode: 0o755 },
    );
  }
```

In the `env` object passed to `spawnSync`, after `SAFE_PNPM_OSV_STRICT: ...`, add:

```js
      SAFE_PNPM_STRICT: opts.strict ? "1" : "",
```

- [ ] **Step 2: Write the failing two-phase tests**

Append to `test/two-phase.test.js`:

```js
// The CVE audit runs on the host after the fetch, against the lockfile phase 1
// resolved, in a throwaway copy rather than the project.
const AUDIT_SHELLS = new Set(["bash", "zsh"]);
for (const { shell, ext, available } of SHELLS.filter((s) => AUDIT_SHELLS.has(s.shell))) {
  for (const manager of ["npm", "pnpm", "yarn"]) {
    const wrapperFile = `${manager}-wrapper.${ext}`;
    const lockfile = LOCKFILES[manager];

    test(`${manager} (${shell}): the audit reads the phase-1 lockfile in a clean copy`, { skip: !available }, () => {
      const { read, runCount } = runWrapper(manager, wrapperFile, { shell });
      assert.equal(runCount, 2);
      const audit = read("audit.log");
      assert.match(audit, /^LOCK=resolved-by-phase-1$/m, "audits what the fetch resolved");
      assert.match(audit, /^RUNS=1$/m, "runs after phase 1 and before phase 2");
      const cwd = audit.match(/^CWD=(.*)$/m)[1];
      assert.doesNotMatch(cwd, /\/proj$/, "never runs in the project");
      assert.equal(fs.existsSync(cwd), false, "the copy is removed afterwards");
      const files = audit.match(/^FILES=(.*)$/m)[1].trim().split(" ");
      for (const f of [lockfile, "package.json", ".npmrc"]) {
        assert.ok(files.includes(f), `${f} missing from ${files}`);
      }
      for (const f of [".pnpmfile.cjs", "node_modules"]) {
        assert.ok(!files.includes(f), `${f} must not be in the audit copy`);
      }
      if (manager === "pnpm") {
        assert.match(audit, /--config\.ignore-pnpmfile=true/);
      }
    });

    test(`${manager} (${shell}): a failed audit under SAFE_PNPM_STRICT=1 blocks before the build`, { skip: !available }, () => {
      const { read, runCount, status, proj } = runWrapper(manager, wrapperFile, {
        shell,
        auditRc: 1,
        strict: true,
        osvApi: `${osv.url}/ok`,
        phase1Lock: LOCK_WITH[manager]("left-pad"),
      });
      assert.equal(runCount, 1, "no build container");
      assert.notEqual(status, 0);
      const err = read("stderr");
      assert.match(err, /audit-stub: 1 high severity/);
      assert.match(err, /Blocking \(SAFE_PNPM_STRICT=1\)/);
      assert.match(err, /install blocked; nothing was built or copied back/);
      assert.equal(fs.existsSync(path.join(proj, "node_modules")), false);
      assert.equal(fs.existsSync(path.join(proj, lockfile)), false);
    });

    test(`${manager} (${shell}): a failed audit warns and continues by default`, { skip: !available }, () => {
      const { read, runCount, proj } = runWrapper(manager, wrapperFile, { shell, auditRc: 1 });
      assert.equal(runCount, 2);
      assert.match(read("stderr"), /continuing in non-interactive mode/);
      assert.ok(fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")));
    });
  }
}
```

The strict test needs `osvApi` and a clean lock. Under `SAFE_PNPM_STRICT=1`, a missing malware scanner blocks on its own, before the audit is ever reached.

- [ ] **Step 3: Update `test/hardening.test.js`**

In `sandbox()`, directly after the `for (const f of fs.readdirSync(ASSETS_DIR))` copy loop, add:

```js
  // The real scanner would query api.osv.dev.
  fs.writeFileSync(
    path.join(home, ".safe-pnpm", "malware-scan.js"),
    'console.log("0 packages checked against OSV");\n',
  );
```

Replace the `RUN` constant with:

```js
const RUN =
  'source "$HOME/.safe-pnpm/_safe_pkg_shared.sh"; _safe_pkg_dispatch npm package-lock.json "" "package.json package-lock.json .npmrc" install';

// Docker hook that stands in for a fetch: creates node_modules in the sandbox
// (the host side of `-v DIR:/app`), so a missed block would copy it back.
const MAKE_MODULES =
  'src=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && src="${a%%:/app}"; prev="$a"; done; mkdir -p "$src/node_modules/dep"';
```

The lockfile is now in the manifest list, so the fetch sandbox, the snapshot and the audit all get it.

Replace the two tests `audit failure warns and continues by default (${shell})` and `SAFE_PNPM_STRICT=1 blocks on audit failure before any container (${shell})` with:

```js
  test(`audit failure warns and continues by default (${shell})`, () => {
    const sb = sandbox({ auditRc: 1 });
    const r = spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: sb.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(r.stderr, /audit-stub: 1 high severity/);
    assert.match(r.stderr, /continuing in non-interactive mode/);
    assert.ok(sb.dockerLog().includes("rebuild"), "the build still ran");
  });

  test(`SAFE_PNPM_STRICT=1 blocks on audit failure before the build (${shell})`, () => {
    const sb = sandbox({ auditRc: 1, dockerHook: MAKE_MODULES });
    const r = spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: { ...sb.env, SAFE_PNPM_STRICT: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /audit-stub: 1 high severity/);
    assert.match(r.stderr, /Blocking \(SAFE_PNPM_STRICT=1\)/);
    assert.match(r.stderr, /install blocked; nothing was built or copied back/);
    const runs = sb
      .dockerLog()
      .split("\n")
      .filter((l) => l.startsWith("run"));
    assert.equal(runs.length, 1, "only the fetch ran");
    assert.equal(fs.existsSync(path.join(sb.proj, "node_modules")), false, "nothing copied back");
  });
```

- [ ] **Step 4: Update the comment in `test/socket.test.js`**

Replace

```js
// not break the install — the CVE audit has already run and the malware check
// still runs after the fetch.
```

with

```js
// not break the install — the CVE audit and the malware check both still run
// after the fetch.
```

- [ ] **Step 5: Run the tests, verify they fail**

```bash
node --test test/two-phase.test.js test/hardening.test.js > SCRATCH/t7-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail|skipped)' SCRATCH/t7-red.log
grep -E '^not ok' SCRATCH/t7-red.log
```

Expected:
- `exit=1`.
- The failures are:
  - the new two-phase audit tests (`audit.log` is missing, `runCount` is 0 or 2, and so on)
  - both hardening audit tests, per available shell (strict: `Blocking` is missing because the prescan no longer sees a lockfile, or `only the fetch ran`)
- All other existing tests still pass. If one fails, stop: Step 1 broke the harness.

- [ ] **Step 6: Remove the audit from `_safe_pkg_prescan`**

In `assets/_safe_pkg_shared.sh`, replace the start of `_safe_pkg_prescan`, from `_safe_pkg_prescan() {` through the `fi` that closes `if [ -f "$lockfile" ]; then` (lines 6-45), with:

```sh
_safe_pkg_prescan() {
  # $1 (manager) and $2 (lockfile) are no longer read: the CVE audit moved to
  # _safe_pkg_audit, after the fetch. The positions stay so callers and tests
  # keep their argument order.
  # socket_flag is set to 1 by the wrapper when `--socket` was passed on the
  # command line. Combined with SAFE_PNPM_ENABLE_SOCKET, it opts this run into
  # the Socket behavioral scan (off by default).
  local socket_flag="${3:-0}"
  local interactive=0
  [ -t 0 ] && interactive=1
```

The Socket block that follows (`# Socket is opt-in: ...` through the function's closing `}`) stays unchanged.

- [ ] **Step 7: Add `_safe_pkg_audit`**

In `assets/_safe_pkg_shared.sh`, insert directly after the closing `}` of `_safe_pkg_malware_scan()`:

```sh

# _safe_pkg_audit manager lockfile treedir projdir auditdir
# Runs the manager's CVE audit on the host against the lockfile the fetch
# resolved, so packages passed to `add` are covered too. treedir is the
# post-fetch snapshot; projdir supplies registry config. The audit runs in
# auditdir, a fresh copy, never in the project: there the manager would load
# the project's .pnpmfile.cjs on the host. pnpm is also told to ignore any
# pnpmfile. Returns 1 when the install must stop.
_safe_pkg_audit() {
  local manager="$1" lockfile="$2" treedir="$3" projdir="$4" auditdir="$5"
  [ -f "$treedir/$lockfile" ] || return 0
  local interactive=0
  [ -t 0 ] && interactive=1

  rm -rf "$auditdir"
  mkdir -p "$auditdir" || return 1
  cp -R "$treedir/." "$auditdir/" || return 1
  local f
  for f in .npmrc .yarnrc pnpm-workspace.yaml; do
    [ -f "$projdir/$f" ] && cp "$projdir/$f" "$auditdir/$f"
  done

  echo "→ $manager audit..." >&2
  # Output is kept and shown on failure: a non-zero exit means either
  # advisories or that the audit itself could not run (offline, registry
  # error), and the user needs the text to tell which.
  local audit_out="${auditdir}.log" audit_rc _ans
  case "$manager" in
    pnpm) ( cd "$auditdir" && command pnpm audit --audit-level moderate --config.ignore-pnpmfile=true ) >"$audit_out" 2>&1 ;;
    npm)  ( cd "$auditdir" && command npm  audit --audit-level moderate ) >"$audit_out" 2>&1 ;;
    yarn) ( cd "$auditdir" && command yarn audit ) >"$audit_out" 2>&1 ;;
  esac
  audit_rc=$?
  # The copy holds the project's .npmrc, token included.
  rm -rf "$auditdir"

  if [ "$audit_rc" -ne 0 ]; then
    tail -n 40 "$audit_out" >&2
    rm -f "$audit_out"
    if [ "${SAFE_PNPM_STRICT:-}" = "1" ]; then
      echo "✗ $manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." >&2
      echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
      return 1
    fi
    if [ "$interactive" -eq 1 ]; then
      printf "⚠️  %s audit failed or found issues. Continue anyway? [y/N] " "$manager" >&2
      read -r _ans
      case "$_ans" in
        [Yy]*) ;;
        *) echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2; return 1 ;;
      esac
    else
      echo "⚠️  $manager audit failed or found issues — continuing in non-interactive mode." >&2
    fi
    return 0
  fi
  rm -f "$audit_out"
}
```

- [ ] **Step 8: Call it after the snapshot**

In `_safe_pkg_sandbox`, find the snapshot block: it starts `if [ "$fetched" -eq 1 ]; then` / `mkdir -p "$snapdir/tree"` and ends with `done < "$snapdir/members"` / `fi`. Insert directly after that block's closing `fi`, before `if [ "$fetched" -eq 1 ] && [ "$run_build" -eq 1 ]`:

```sh

  # CVE audit of the tree the fetch resolved, so a package passed to `add` is
  # covered. It runs before any package code; a block discards the sandbox like
  # a malware hit does.
  if [ "$fetched" -eq 1 ]; then
    if ! _safe_pkg_audit "$manager" "$lockfile" "$snapdir/tree" "$workspace_root" "$snapdir/audit"; then
      fetched=0
      rc=1
    fi
  fi
```

Setting `fetched=0` skips both the build and the copy-back, which are gated on it.

- [ ] **Step 9: Run the tests, verify they pass**

```bash
node --test test/two-phase.test.js test/hardening.test.js test/socket.test.js > SCRATCH/t7-green.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail|skipped)' SCRATCH/t7-green.log
```

Expected: `exit=0`, `# fail 0`.

- [ ] **Step 10: Full suite**

```bash
node --test test/*.test.js > SCRATCH/t7-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t7-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = PR B baseline + 18 (3 tests × 3 managers × bash and zsh).
- The fish hardening audit tests still pass, because fish still audits before the fetch.

- [ ] **Step 11: Commit**

```bash
git add assets/_safe_pkg_shared.sh test/two-phase.test.js test/hardening.test.js test/socket.test.js
git commit -m "fix: run the sh CVE audit after the fetch, on the resolved lockfile, outside the project"
```

---

### Task 8: fish audit after the fetch

**Files:**
- Modify: `assets/_safe_pkg_prescan.fish` (`_safe_pkg_prescan` lines 4-39; new `_safe_pkg_audit` after `_safe_pkg_malware_scan`)
- Modify: `assets/npm-wrapper.fish`, `assets/yarn-wrapper.fish`, `assets/pnpm-wrapper.fish` (the `if test $rc -eq 0` block after the malware scan)
- Modify: `test/two-phase.test.js` (drop the `AUDIT_SHELLS` filter)
- Modify: `test/hardening-fish.test.js` (sandbox, the two audit tests)

- [ ] **Step 1: Turn the fish tests on**

In `test/two-phase.test.js`, delete the line `const AUDIT_SHELLS = new Set(["bash", "zsh"]);`, and change

```js
for (const { shell, ext, available } of SHELLS.filter((s) => AUDIT_SHELLS.has(s.shell))) {
```

to

```js
for (const { shell, ext, available } of SHELLS) {
```

In `test/hardening-fish.test.js`:

In `sandbox()`, after the `fs.writeFileSync(path.join(bin, "npm"), ...)` call, add:

```js
  // The real scanner would query api.osv.dev, and under SAFE_PNPM_STRICT=1 a
  // missing one blocks before the audit is reached.
  fs.writeFileSync(
    path.join(home, ".safe-pnpm", "malware-scan.js"),
    'console.log("0 packages checked against OSV");\n',
  );
```

After the `RUN` constant, add:

```js
// Docker hook that stands in for a fetch: creates node_modules in the sandbox
// (the host side of `-v DIR:/app`), so a missed block would copy it back.
const MAKE_MODULES =
  'src=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && src="${a%%:/app}"; prev="$a"; done; mkdir -p "$src/node_modules/dep"';
```

Replace the tests `fish: audit failure shows output and continues by default` and `fish: SAFE_PNPM_STRICT=1 blocks on audit failure before any container` with:

```js
test("fish: audit failure shows output and continues by default", opts, () => {
  const sb = sandbox({ auditRc: 1 });
  const r = runFish(sb);
  assert.match(r.stderr, /audit-stub: 1 high severity/);
  assert.match(r.stderr, /audit failed or found issues — continuing in non-interactive mode/);
  assert.ok(sb.dockerLog().includes("rebuild"), "the build still ran");
});

test("fish: SAFE_PNPM_STRICT=1 blocks on audit failure before the build", opts, () => {
  const sb = sandbox({ auditRc: 1, dockerHook: MAKE_MODULES });
  const r = runFish(sb, { SAFE_PNPM_STRICT: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /audit-stub: 1 high severity/);
  assert.match(r.stderr, /npm audit failed or found issues\. Blocking \(SAFE_PNPM_STRICT=1\)/);
  assert.match(r.stderr, /install blocked; nothing was built or copied back/);
  const runs = sb
    .dockerLog()
    .split("\n")
    .filter((l) => l.startsWith("run"));
  assert.equal(runs.length, 1, "only the fetch ran");
  assert.equal(fs.existsSync(path.join(sb.proj, "node_modules")), false, "nothing copied back");
});
```

- [ ] **Step 2: Run them, verify they fail**

```bash
node --test test/two-phase.test.js test/hardening-fish.test.js > SCRATCH/t8-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail|skipped)' SCRATCH/t8-red.log
```

Expected:
- With fish installed: `exit=1`. The 9 fish audit tests in two-phase fail, plus the 2 fish hardening audit tests.
- Without fish: those tests are skipped. Report that the fish path is unverified locally and relies on CI, which installs fish.

- [ ] **Step 3: Remove the audit from the fish prescan and add `_safe_pkg_audit`**

In `assets/_safe_pkg_prescan.fish`, replace the start of `_safe_pkg_prescan`, from `function _safe_pkg_prescan --argument manager lockfile socket_flag` through the `end` that closes `if test -f $lockfile` (lines 4-39), with:

```fish
function _safe_pkg_prescan --argument manager lockfile socket_flag
    # manager and lockfile are no longer read: the CVE audit moved to
    # _safe_pkg_audit, after the fetch. The positions stay so callers keep
    # their argument order.
```

The Socket block that follows stays unchanged.

Insert directly after the `end` that closes `function _safe_pkg_malware_scan`:

```fish

# Runs the manager's CVE audit on the host against the lockfile the fetch
# resolved, so packages passed to `add` are covered too. See _safe_pkg_shared.sh
# for the rationale: the audit runs in auditdir, a fresh copy of the snapshot in
# treedir plus projdir's registry config, never in the project, where the
# manager would load the project's .pnpmfile.cjs on the host. Returns 1 when
# the install must stop.
function _safe_pkg_audit --argument manager lockfile treedir projdir auditdir
    test -f "$treedir/$lockfile"; or return 0
    rm -rf $auditdir
    mkdir -p $auditdir; or return 1
    cp -R "$treedir/." "$auditdir/"; or return 1
    for f in .npmrc .yarnrc pnpm-workspace.yaml
        if test -f "$projdir/$f"
            cp "$projdir/$f" "$auditdir/$f"
        end
    end

    echo "→ $manager audit..." >&2
    # Output is kept and shown on failure: a non-zero exit means either
    # advisories or that the audit itself could not run (offline, registry
    # error), and the user needs the text to tell which.
    set -l audit_out "$auditdir.log"
    pushd $auditdir
    switch $manager
        case pnpm
            command pnpm audit --audit-level moderate --config.ignore-pnpmfile=true >$audit_out 2>&1
        case npm
            command npm audit --audit-level moderate >$audit_out 2>&1
        case yarn
            command yarn audit >$audit_out 2>&1
    end
    set -l audit_rc $status
    popd
    # The copy holds the project's .npmrc, token included.
    rm -rf $auditdir

    if test $audit_rc -ne 0
        tail -n 40 $audit_out >&2
        rm -f $audit_out
        if test "$SAFE_PNPM_STRICT" = "1"
            echo "✗ $manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." >&2
            echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
            return 1
        end
        if isatty stdin
            read --prompt-str "⚠️  $manager audit failed or found issues. Continue anyway? [y/N] " _ans
            if not string match -qi 'y*' "$_ans"
                echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
                return 1
            end
        else
            echo "⚠️  $manager audit failed or found issues — continuing in non-interactive mode." >&2
        end
        return 0
    end
    rm -f $audit_out
end
```

- [ ] **Step 4: Split the npm fish block**

In `assets/npm-wrapper.fish`, replace everything from the `if test $rc -eq 0` that directly follows the malware-scan block, through its closing `end` (the line before `_safe_pkg_untrack $tmpdir $snapdir`), with the code below. The `docker run` line keeps `$user_flags` from PR A.

```fish
    if test $rc -eq 0
        # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
        # code, so these hold only the package manager's own edits. Phase 2
        # build scripts can rewrite anything under /app; a rewritten
        # package.json script or lockfile URL would run natively on the next
        # host command, so copy-back reads manifests from here, never from the
        # sandbox.
        mkdir -p $snapdir/tree
        for f in package.json package-lock.json
            if test -f "$tmpdir/$f"
                cp "$tmpdir/$f" "$snapdir/tree/$f"
            end
        end

        # CVE audit of the tree the fetch resolved, so a package passed to `add`
        # is covered. It runs before any package code; a block discards the
        # sandbox like a malware hit does.
        _safe_pkg_audit npm package-lock.json $snapdir/tree $PWD $snapdir/audit
        or set rc 1
    end

    if test $rc -eq 0
        # Strip registry credentials before any build script can run.
        _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
        _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

        set -l net_flag --network none
        if test "$SAFE_PNPM_BUILD_NETWORK" = 1
            set net_flag
        end

        # Phase 2: build (no token, no .npmrc auth, network off by default).
        docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w /app \
            safe-pnpm:latest npm rebuild $store_flag
        set rc $status

        # A node_modules swapped for a symlink could pull in files from anywhere
        # the link points; copy back only a plain directory.
        if test -L "$tmpdir/node_modules"; or begin; test -e "$tmpdir/node_modules"; and not test -d "$tmpdir/node_modules"; end
            echo "✗ safe-pnpm: sandbox node_modules is not a plain directory; not copied back." >&2
            set rc 1
        else if test -d "$tmpdir/node_modules"
            if _safe_pkg_links_ok $tmpdir node_modules
                rm -rf node_modules
                cp -R "$tmpdir/node_modules" node_modules
            else
                set rc 1
            end
        end
        for f in package.json package-lock.json
            if test -f "$snapdir/tree/$f"
                cp "$snapdir/tree/$f" $f
            end
        end
    end
```

The snapshot moves from `$snapdir/$f` to `$snapdir/tree/$f`. Copying `$snapdir/.` into `$snapdir/audit` would copy the audit dir into itself; copying `$snapdir/tree` avoids that.

- [ ] **Step 5: Split the yarn fish block**

In `assets/yarn-wrapper.fish`, replace the same span (from the `if test $rc -eq 0` after the malware-scan block through the `end` before `_safe_pkg_untrack`) with:

```fish
    if test $rc -eq 0
        # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
        # code, so these hold only the package manager's own edits. Phase 2
        # build scripts can rewrite anything under /app; a rewritten
        # package.json script or lockfile URL would run natively on the next
        # host command, so copy-back reads manifests from here, never from the
        # sandbox.
        mkdir -p $snapdir/tree
        for f in package.json yarn.lock
            if test -f "$tmpdir/$f"
                cp "$tmpdir/$f" "$snapdir/tree/$f"
            end
        end

        # CVE audit of the tree the fetch resolved, so a package passed to `add`
        # is covered. It runs before any package code; a block discards the
        # sandbox like a malware hit does.
        _safe_pkg_audit yarn yarn.lock $snapdir/tree $PWD $snapdir/audit
        or set rc 1
    end

    if test $rc -eq 0
        # Strip registry credentials before any build script can run.
        _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
        _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

        set -l net_flag --network none
        if test "$SAFE_PNPM_BUILD_NETWORK" = 1
            set net_flag
        end

        # Phase 2: build (no token, no .npmrc auth, network off by default).
        docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w /app \
            safe-pnpm:latest yarn install --offline --force $store_flag
        set rc $status

        # A node_modules swapped for a symlink could pull in files from anywhere
        # the link points; copy back only a plain directory.
        if test -L "$tmpdir/node_modules"; or begin; test -e "$tmpdir/node_modules"; and not test -d "$tmpdir/node_modules"; end
            echo "✗ safe-pnpm: sandbox node_modules is not a plain directory; not copied back." >&2
            set rc 1
        else if test -d "$tmpdir/node_modules"
            if _safe_pkg_links_ok $tmpdir node_modules
                rm -rf node_modules
                cp -R "$tmpdir/node_modules" node_modules
            else
                set rc 1
            end
        end
        for f in package.json yarn.lock
            if test -f "$snapdir/tree/$f"
                cp "$snapdir/tree/$f" $f
            end
        end
    end
```

- [ ] **Step 6: Split the pnpm fish block**

In `assets/pnpm-wrapper.fish`, the snapshot already writes to `$snapdir/tree`, so nothing moves. Only insert lines; delete nothing.

Find the insertion point: the `end` that closes `for m in $members` (the members snapshot loop, around line 139). Right after it comes a blank line, then this comment:

```fish
        # `pnpm fetch` only populates the store; there is nothing to build.
```

Insert the following immediately after that `end` and before the blank line:

```fish

        # CVE audit of the tree the fetch resolved, so a package passed to `add`
        # is covered. It runs before any package code; a block discards the
        # sandbox like a malware hit does.
        _safe_pkg_audit pnpm pnpm-lock.yaml $snapdir/tree $workspace_root $snapdir/audit
        or set rc 1
    end

    if test $rc -eq 0
```

The result: the first `if test $rc -eq 0` block holds the snapshot and the audit. A second `if test $rc -eq 0` block holds the `fetch` check, the build, the copy-back loop and the manifest restore, all unchanged. That second block ends at the `end` that previously closed the single block.

Check the structure:

```bash
fish -n assets/pnpm-wrapper.fish assets/npm-wrapper.fish assets/yarn-wrapper.fish assets/_safe_pkg_prescan.fish; echo "exit=$?"
```

Expected: `exit=0`. If fish isn't installed, skip this check and say so.

- [ ] **Step 7: Run the tests, verify they pass**

```bash
node --test test/two-phase.test.js test/hardening-fish.test.js > SCRATCH/t8-green.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail|skipped)' SCRATCH/t8-green.log
```

Expected: `exit=0`, `# fail 0`.

- [ ] **Step 8: Full suite**

```bash
node --test test/*.test.js > SCRATCH/t8-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t8-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = PR B baseline + 27.

- [ ] **Step 9: Commit**

```bash
git add assets/_safe_pkg_prescan.fish assets/npm-wrapper.fish assets/yarn-wrapper.fish assets/pnpm-wrapper.fish test/two-phase.test.js test/hardening-fish.test.js
git commit -m "fix: run the fish CVE audit after the fetch, on the resolved lockfile, outside the project"
```

---

### Task 9: PowerShell audit after the fetch

**Files:**
- Modify: `test/ps1-wrappers.test.js` (`runPs1` gains audit stubs, a malware stub, a pnpmfile and an `auditRc` option; new tests)
- Modify: `assets/_safe_pkg_shared.ps1` (`_Safe_Pkg_Prescan` lines 7-40; new `_Safe_Pkg_Audit` after `_Safe_Pkg_Malware_Scan`)
- Modify: `assets/npm-wrapper.ps1`, `assets/yarn-wrapper.ps1` (the `if ($rc -eq 0)` block, lines 65-84)
- Modify: `assets/pnpm-wrapper.ps1` (the `if ($rc -eq 0)` block, about lines 96-123)

- [ ] **Step 1: Extend `runPs1`**

In `test/ps1-wrappers.test.js`:

Change the signature `function runPs1(manager, { env = {} } = {}) {` to `function runPs1(manager, { env = {}, auditRc = 0 } = {}) {`.

After the `fs.writeFileSync(path.join(bin, "docker"), ...)` call, add:

```js
  // Host-side audit stubs. Each call records where it ran, its arguments, the
  // files it could see, the lockfile it read, and how many docker runs had
  // happened by then.
  for (const m of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(
      path.join(bin, m),
      [
        "#!/bin/sh",
        `{ echo "CWD=$(pwd)"; echo "ARGS=$*"; echo "FILES=$(ls -A | tr '\\n' ' ')"; echo "LOCK=$(cat ${LOCKFILES[manager]} 2>/dev/null)"; echo "RUNS=$(grep -c '' /w/docker.log)"; } >> /w/audit.log`,
        'echo "audit-stub: 1 high severity vulnerability"',
        `exit ${auditRc}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  // The real scanner would query api.osv.dev, and under SAFE_PNPM_STRICT=1 a
  // missing one blocks before the audit is reached.
  fs.writeFileSync(
    path.join(safe, "malware-scan.js"),
    'console.log("0 packages checked against OSV");\n',
  );
```

After the `.npmrc` `fs.writeFileSync(...)`, add:

```js
  fs.writeFileSync(path.join(proj, ".pnpmfile.cjs"), "module.exports = {};\n");
```

- [ ] **Step 2: Write the failing tests**

Append to `test/ps1-wrappers.test.js`:

```js
for (const manager of ["npm", "pnpm", "yarn"]) {
  const lockfile = LOCKFILES[manager];

  test(`ps1 ${manager}: the audit reads the phase-1 lockfile in a clean copy`, { skip }, () => {
    const { out, runs, read } = runPs1(manager);
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    const audit = read("audit.log");
    assert.match(audit, /^LOCK=resolved-by-phase-1$/m, out);
    assert.match(audit, /^RUNS=1$/m, "runs after phase 1 and before phase 2");
    assert.match(audit, /^CWD=.*\/audit$/m, "runs in the throwaway copy");
    const files = audit.match(/^FILES=(.*)$/m)[1].trim().split(" ");
    for (const f of [lockfile, "package.json", ".npmrc"]) {
      assert.ok(files.includes(f), `${f} missing from ${files}`);
    }
    for (const f of [".pnpmfile.cjs", "node_modules"]) {
      assert.ok(!files.includes(f), `${f} must not be in the audit copy`);
    }
    if (manager === "pnpm") {
      assert.match(audit, /--config\.ignore-pnpmfile=true/);
    }
  });

  test(`ps1 ${manager}: a failed audit under SAFE_PNPM_STRICT=1 blocks before the build`, { skip }, () => {
    const { out, runs, proj } = runPs1(manager, {
      auditRc: 1,
      env: { SAFE_PNPM_STRICT: "1" },
    });
    assert.match(out, /audit-stub: 1 high severity/);
    assert.match(out, /Blocking \(SAFE_PNPM_STRICT=1\)/);
    assert.match(out, /install blocked; nothing was built or copied back/);
    assert.match(out, /RC=1/);
    assert.equal(runs.length, 1, out);
    assert.equal(fs.existsSync(path.join(proj, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(proj, lockfile)), false);
  });

  test(`ps1 ${manager}: a failed audit warns and continues by default`, { skip }, () => {
    const { out, runs, proj } = runPs1(manager, { auditRc: 1 });
    assert.match(out, /continuing in non-interactive mode/);
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    assert.ok(fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")));
  });
}
```

- [ ] **Step 3: Run them, verify they fail**

```bash
node --test test/ps1-wrappers.test.js > SCRATCH/t9-red.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail)' SCRATCH/t9-red.log
```

Expected:
- `exit=1`, `# fail 9`: the 9 new tests fail, with `audit.log` empty or `runs.length` 2 under strict.
- The 4 Task 3 tests still pass.

- [ ] **Step 4: Remove the audit from `_Safe_Pkg_Prescan`**

In `assets/_safe_pkg_shared.ps1`, replace the `if (Test-Path $Lockfile) { ... }` block inside `_Safe_Pkg_Prescan` (from `    if (Test-Path $Lockfile) {` through its closing `    }`, lines 10-40) with:

```powershell
    # $Manager and $Lockfile are no longer read: the CVE audit moved to
    # _Safe_Pkg_Audit, after the fetch. The parameters stay so callers keep
    # working.
```

The `param(...)` line and the Socket block that follows stay unchanged.

- [ ] **Step 5: Add `_Safe_Pkg_Audit`**

Insert directly after the closing `}` of `function _Safe_Pkg_Malware_Scan`:

```powershell

# Runs the manager's CVE audit on the host against the lockfile the fetch
# resolved, so packages passed to `add` are covered too. See
# _safe_pkg_shared.sh for the rationale: the audit runs in AuditDir, a fresh
# copy of the snapshot plus ProjDir's registry config, never in the project,
# where the manager would load the project's .pnpmfile.cjs on the host.
# Returns $false when the install must stop.
function _Safe_Pkg_Audit {
    param([string]$Manager, [string]$Lockfile, [string]$TreeDir, [string[]]$RelPaths, [string]$ProjDir, [string]$AuditDir)
    if (-not (Test-Path -LiteralPath (Join-Path $TreeDir $Lockfile) -PathType Leaf)) { return $true }

    New-Item -Type Directory -Force $AuditDir | Out-Null
    _Safe_Pkg_Copy_Files -From $TreeDir -To $AuditDir -RelPaths $RelPaths
    _Safe_Pkg_Copy_Files -From $ProjDir -To $AuditDir -RelPaths @('.npmrc','.yarnrc','pnpm-workspace.yaml')

    Write-Host "→ $Manager audit..." -ForegroundColor Cyan
    $mgr = (Get-Command $Manager -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    # Output is kept and shown on failure: a non-zero exit means either
    # advisories or that the audit itself could not run (offline, registry
    # error), and the user needs the text to tell which.
    $auditOut = "$AuditDir.log"
    try {
        Push-Location $AuditDir
        try {
            if (-not $mgr) {
                "$Manager not found on PATH" | Set-Content $auditOut
                $auditRc = 127
            } else {
                switch ($Manager) {
                    'pnpm' { & $mgr audit --audit-level moderate --config.ignore-pnpmfile=true *> $auditOut }
                    'npm'  { & $mgr audit --audit-level moderate *> $auditOut }
                    'yarn' { & $mgr audit *> $auditOut }
                }
                $auditRc = $LASTEXITCODE
            }
        } finally {
            Pop-Location
            # The copy holds the project's .npmrc, token included.
            Remove-Item -Recurse -Force $AuditDir -ErrorAction SilentlyContinue
        }

        if ($auditRc -ne 0) {
            Get-Content $auditOut -Tail 40 | ForEach-Object { [Console]::Error.WriteLine($_) }
            if ($env:SAFE_PNPM_STRICT -eq '1') {
                Write-Host "✗ $Manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." -ForegroundColor Red
                Write-Host "✗ safe-pnpm: install blocked; nothing was built or copied back." -ForegroundColor Red
                return $false
            }
            if (-not [Console]::IsInputRedirected) {
                $ans = Read-Host "⚠️  $Manager audit failed or found issues. Continue anyway? [y/N]"
                if ($ans -notmatch '^[Yy]') {
                    Write-Host "✗ safe-pnpm: install blocked; nothing was built or copied back." -ForegroundColor Red
                    return $false
                }
            } else {
                Write-Host "⚠️  $Manager audit failed or found issues — continuing in non-interactive mode." -ForegroundColor Yellow
            }
        }
        return $true
    } finally {
        Remove-Item $auditOut -Force -ErrorAction SilentlyContinue
    }
}
```

A missing manager now counts as an audit that could not run (127). The old prescan called `& $null` there, which failed with a confusing error.

- [ ] **Step 6: Split the npm ps1 block**

In `assets/npm-wrapper.ps1`, replace the whole `if ($rc -eq 0) { ... }` block after the malware-scan line (lines 65-84) with:

```powershell
        if ($rc -eq 0) {
            $manifests = @('package.json','package-lock.json')
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit of the tree the fetch resolved, so a package passed to
            # `add` is covered. It runs before any package code; a block discards
            # the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit -Manager npm -Lockfile 'package-lock.json' -TreeDir $snapDir.FullName -RelPaths $manifests -ProjDir (Get-Location).Path -AuditDir (Join-Path $snapDir.FullName 'audit'))) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + (_Safe_Pkg_User) + $netFlag +
                @('-v',"$($tmpDir.FullName):/app",'-w','/app','safe-pnpm:latest','npm','rebuild') + $storeFlag
            & docker @p2
            $rc = $LASTEXITCODE

            if (-not (_Safe_Pkg_Copy_Modules -Base $tmpDir.FullName -Rel 'node_modules' -DestRoot (Get-Location).Path)) { $rc = 1 }
            _Safe_Pkg_Copy_Files -From $snapDir.FullName -To (Get-Location).Path -RelPaths $manifests
        }
```

PowerShell variables are scoped to the function, not the block, so `$manifests` is still set in the second block.

- [ ] **Step 7: Split the yarn ps1 block**

In `assets/yarn-wrapper.ps1`, replace the same block with:

```powershell
        if ($rc -eq 0) {
            $manifests = @('package.json','yarn.lock')
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit of the tree the fetch resolved, so a package passed to
            # `add` is covered. It runs before any package code; a block discards
            # the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit -Manager yarn -Lockfile 'yarn.lock' -TreeDir $snapDir.FullName -RelPaths $manifests -ProjDir (Get-Location).Path -AuditDir (Join-Path $snapDir.FullName 'audit'))) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + (_Safe_Pkg_User) + $netFlag +
                @('-v',"$($tmpDir.FullName):/app",'-w','/app','safe-pnpm:latest','yarn','install','--offline','--force') + $storeFlag
            & docker @p2
            $rc = $LASTEXITCODE

            if (-not (_Safe_Pkg_Copy_Modules -Base $tmpDir.FullName -Rel 'node_modules' -DestRoot (Get-Location).Path)) { $rc = 1 }
            _Safe_Pkg_Copy_Files -From $snapDir.FullName -To (Get-Location).Path -RelPaths $manifests
        }
```

- [ ] **Step 8: Split the pnpm ps1 block**

In `assets/pnpm-wrapper.ps1`, replace the `if ($rc -eq 0) { ... }` block after the malware-scan line with:

```powershell
        if ($rc -eq 0) {
            $manifests = @('package.json','pnpm-lock.yaml') + @($members | ForEach-Object { Join-Path $_ 'package.json' })
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit of the tree the fetch resolved, so a package passed to
            # `add` is covered. It runs before any package code; a block discards
            # the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit -Manager pnpm -Lockfile 'pnpm-lock.yaml' -TreeDir $snapDir.FullName -RelPaths $manifests -ProjDir $workspaceRoot -AuditDir (Join-Path $snapDir.FullName 'audit'))) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # `pnpm fetch` only populates the store; there is nothing to build.
            if ($cmd -ne 'fetch') {
                # Strip registry credentials before any build script can run.
                _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
                _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

                $netFlag = @('--network','none')
                if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

                # Phase 2: build (no token, no .npmrc auth, network off by default).
                $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + (_Safe_Pkg_User) + $netFlag +
                    @('-v',"$($tmpDir.FullName):/app",'-w',$workdir,'safe-pnpm:latest','pnpm','install','--offline','--trust-lockfile') + $storeFlag
                & docker @p2
                $rc = $LASTEXITCODE
            }

            # Only node_modules at the root and in pre-existing workspace members
            # come back, so phase 2 cannot plant node_modules elsewhere in the project.
            $moduleDirs = @('node_modules') + @($members | ForEach-Object { Join-Path $_ 'node_modules' })
            foreach ($rel in $moduleDirs) {
                if (-not (_Safe_Pkg_Copy_Modules -Base $tmpDir.FullName -Rel $rel -DestRoot $workspaceRoot)) { $rc = 1 }
            }
            _Safe_Pkg_Copy_Files -From $snapDir.FullName -To $workspaceRoot -RelPaths $manifests
        }
```

- [ ] **Step 9: Run the tests, verify they pass**

```bash
node --test test/ps1-wrappers.test.js test/ps1-copy-back.test.js > SCRATCH/t9-green.log 2>&1; echo "exit=$?"
grep -E '^# (pass|fail)' SCRATCH/t9-green.log
```

Expected: `exit=0`, `# pass 19`, `# fail 0`.

If the CWD assertion fails with the audit running in `/w/proj`, PowerShell did not pass its location to the native process. Report it; don't weaken the test.

- [ ] **Step 10: Full suite**

```bash
node --test test/*.test.js > SCRATCH/t9-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t9-all.log
```

Expected:
- `exit=0`, `# fail 0`.
- `# tests` = PR B baseline + 36.

- [ ] **Step 11: Commit**

```bash
git add assets/_safe_pkg_shared.ps1 assets/npm-wrapper.ps1 assets/yarn-wrapper.ps1 assets/pnpm-wrapper.ps1 test/ps1-wrappers.test.js
git commit -m "fix: run the PowerShell CVE audit after the fetch, on the resolved lockfile, outside the project"
```

---

### Task 10: Docs for the audit move

No test; docs only.

**Files:**
- Modify: `docs/security.md` (CVE row about line 24, "Novel, unlisted" row about line 33, two-phase list about lines 43-46, strict mode about line 50)
- Modify: `README.md` (status list, "How it works" steps)
- Modify: `docs/socket.md` (about lines 3 and 50)
- Modify: `ROADMAP.md` (about lines 6, 16, 21)

- [ ] **Step 1: `docs/security.md`**

Replace the CVE row

`| Known CVE-listed packages | Partly — \`audit\` runs pre-install and its output is shown. Interactive runs prompt; ...`

so that the whole row reads:

`| Known CVE-listed packages | Partly — \`audit\` runs after the fetch, on the lockfile it resolved (so packages passed to \`add\` are covered), in a clean copy outside your project with no pnpmfile loaded. Its output is shown. Interactive runs prompt; non-interactive runs warn and continue unless \`SAFE_PNPM_STRICT=1\`, which blocks (and also blocks when the audit itself could not run) |`

In the "Novel, unlisted attack packages" row, change `Pre-install scans only catch packages in their databases.` to `The scans only catch packages in their databases.`

In the "Two-phase install" list, insert after item 2 (**Malware check**):

`3. **Audit** — on the host, the package manager's own audit (\`pnpm audit\`, \`npm audit\`, \`yarn audit\`) checks the lockfile the fetch resolved for known CVEs. It runs in a throwaway copy that holds only the manifests, the lockfile and the registry config, never in your project, and pnpm is told to ignore any \`.pnpmfile.cjs\`, so no project code runs on the host. Findings, or an audit that could not run, prompt in a terminal and warn otherwise; \`SAFE_PNPM_STRICT=1\` blocks, which discards the sandbox like a malware hit.`

Renumber **Build** to `4.` and **Copy-back** to `5.`

In "Strict mode", after the sentence ending `set the same behavior for one layer.`, add: ` Every block happens before any package code runs.`

- [ ] **Step 2: `README.md`**

Delete the status line `- The CVE audit runs before the fetch, so a package passed to \`add\` is not covered by it. The OSV malware check does cover it.`

Replace step 1

`1. **Pre-install scan** — manager-native audit (\`pnpm audit\`, \`npm audit\`, \`yarn audit\`) and [Socket behavioral analysis](./docs/socket.md) if configured.`

with

`1. **Pre-install scan** — [Socket behavioral analysis](./docs/socket.md), if configured.`

Insert after step 4 (**Malware check**):

`5. **Audit** — the package manager's own audit (\`pnpm audit\`, \`npm audit\`, \`yarn audit\`) checks the resolved lockfile, including packages being added, for known CVEs. It runs on the host in a throwaway copy of the manifests, not in your project. Findings warn (or prompt in a terminal); \`export SAFE_PNPM_STRICT=1\` blocks instead.`

Renumber **Build in Docker** to `6.` and **Copy results back** to `7.`

- [ ] **Step 3: `docs/socket.md`**

Replace `It runs as a third pre-install layer alongside \`pnpm audit\` (CVE database) and the OSV malware check.` with `It is the one layer that runs before the fetch; the \`pnpm audit\` CVE check and the OSV malware check run after it, on the lockfile the fetch resolved.`

Replace `Socket is an opt-in third layer: the CVE audit has already run, and the OSV malware check still runs after the fetch.` with `Socket is an opt-in third layer: the CVE audit and the OSV malware check both still run after the fetch.`

- [ ] **Step 4: `ROADMAP.md`**

Change only `[ ]` to `[x]` on these three lines. Leave their text unchanged.
- `- [ ] M4 hardening follow-ups (below), remaining: non-root containers, then the CVE audit after phase 1`
- `- [ ] M4 — Hardening follow-ups`
- `  - [ ] Run the CVE audit after phase 1 so a package passed to \`add\` is audited too (OSV already covers malware for it)`

- [ ] **Step 5: Check, then commit**

```bash
grep -n -i 'pre-install\|audit runs before\|has already run' README.md docs/*.md; s=$?; [ $s -eq 1 ] && echo none; [ $s -gt 1 ] && echo "grep error $s"
grep -c '^\s*- \[ \]' ROADMAP.md
```

Expected:
- The first grep prints only README step 1 (`**Pre-install scan**`), the one layer still before the fetch. Anything else is a stale claim to fix.
- The second grep prints `0`.

```bash
git add docs/security.md README.md docs/socket.md ROADMAP.md
git commit -m "docs: CVE audit runs after the fetch; M4 complete"
```

---

### Task 11: Manual smoke test, verify PR B, open it on the user's go

- [ ] **Step 1: Manual smoke with a real vulnerable package**

This uses:
- real Docker with the `safe-pnpm-e2e-test` image (built by `test/image-e2e.test.js`)
- the host's real `npm` for the audit
- the user's installed `~/.safe-pnpm` scanner and link checker

`lodash@4.17.20` has known high-severity advisories.

Write this script with the Write tool to `SCRATCH/smoke-b.sh`:

```bash
#!/bin/bash
A=/Users/jboho/Code/.worktrees/safe-pnpm-m4-audit/assets
S=$(mktemp -d)
mkdir -p "$S/bin" "$S/lenient" "$S/strict"
REAL=$(command -v docker)
cat > "$S/bin/docker" <<EOF
#!/bin/sh
for a in "\$@"; do shift; [ "\$a" = safe-pnpm:latest ] && a=safe-pnpm-e2e-test; set -- "\$@" "\$a"; done
exec "$REAL" "\$@"
EOF
chmod 755 "$S/bin/docker"
for d in lenient strict; do
  echo '{"name":"smoke","version":"1.0.0","private":true}' > "$S/$d/package.json"
done
echo "npm on host: $(command -v npm)"
echo "--- lenient"
( cd "$S/lenient" && PATH="$S/bin:$PATH" SAFE_PNPM_STRICT= bash -c "source $A/_safe_pkg_shared.sh; source $A/npm-wrapper.sh; npm install lodash@4.17.20 </dev/null" )
echo "lenient exit=$?"
ls "$S/lenient"
echo "--- strict"
( cd "$S/strict" && PATH="$S/bin:$PATH" SAFE_PNPM_STRICT=1 bash -c "source $A/_safe_pkg_shared.sh; source $A/npm-wrapper.sh; npm install lodash@4.17.20 </dev/null" )
echo "strict exit=$?"
ls -A "$S/strict"
echo "scratch: $S"
```

```bash
bash SCRATCH/smoke-b.sh > SCRATCH/smoke-b.log 2>&1; echo "exit=$?"
grep -E 'npm on host|audit|exit=|blocked|^---' SCRATCH/smoke-b.log
```

Expected:
- `npm on host:` prints a path. If it's empty, stop: the host audit can't run.
- lenient: `→ npm audit...`, then `npm audit failed or found issues — continuing in non-interactive mode`, then `lenient exit=0`. `ls` shows `node_modules` and `package-lock.json`.
- strict: `Blocking (SAFE_PNPM_STRICT=1)` and `install blocked; nothing was built or copied back`, then a non-zero `strict exit=`. `ls -A` shows only `package.json`.

Leave the scratch dir in place. It's under the system temp dir, and deleting it is not part of this task.

- [ ] **Step 2: Full suite and lint**

```bash
node --test test/*.test.js > SCRATCH/t11-all.log 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail|skipped)' SCRATCH/t11-all.log
docker run --rm -v "$PWD:/app" -w /app node:22-alpine sh -c 'npm run lint' > SCRATCH/t11-lint.log 2>&1; echo "exit=$?"
```

Expected:
- Tests: `exit=0`, `# fail 0`, `# tests` = PR B baseline + 36.
- Lint: `exit=0`, or the Task 0 caveat applies.

- [ ] **Step 3: Review the branch diff**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected:
- 4 commits (Tasks 7-10).
- Only files from the PR B rows of the file map.

- [ ] **Step 4: STOP — human gate**

Show the user:
- the commit list
- the diff stat
- the smoke-test lines from Step 1

Ask: "Push `feat/m4-audit-after-fetch` and open a PR into `main`? Merging it moves the CVE audit to after the fetch in every shell and finishes M4." Do not push until the user says yes.

- [ ] **Step 5: Push and open the PR (after the yes)**

Write `SCRATCH/pr-b-body.md` first with the Write tool. It has three parts:
- **What changes:** the audit leaves the prescan and runs on the host after the fetch, the malware scan and the snapshot. It runs in a throwaway copy, with pnpm told to ignore pnpmfiles. Strict mode now blocks after the fetch: nothing is built or copied back.
- **Why:** packages passed to `add` were never audited.
- **Tests:** two-phase, hardening, fish and ps1 audit tests, plus the manual smoke output. Give the local counts and the lint result.

```bash
git push origin HEAD:refs/heads/feat/m4-audit-after-fetch
gh pr create --repo jboho/safe-pnpm --base main --head feat/m4-audit-after-fetch --title "fix: run the CVE audit after the fetch so added packages are covered" --body-file SCRATCH/pr-b-body.md
```

Wait for CI and give the user the run id and result. The user merges.

---

## Known limits (state them in the PR bodies)

- An interactive "Continue anyway? [y/N]" decline can't be tested without a terminal. The tests cover strict-block and non-interactive-continue only. The decline path prints the same "install blocked" line as strict.
- Windows PowerShell still runs the containers as root (documented in README and docs/security.md).
- On macOS, Docker Desktop hides file ownership, so the e2e test's "sandbox removed" assertion fails before the fix only on Linux (CI). On macOS, the `--user` assertion is what fails before the fix.
