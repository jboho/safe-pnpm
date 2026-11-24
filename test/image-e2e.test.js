const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ASSETS_DIR, wrapperInstall } = require("./helpers/wrapper-install");
const IMAGE = "safe-pnpm-e2e-test";
const LOCKFILES = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

const hasDocker =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const skip = hasDocker ? false : "docker not available";

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
// from assets/Dockerfile. The project has no dependencies, so nothing is
// downloaded.
const install = (manager, opts = {}) =>
  wrapperInstall({ tmp, image: IMAGE, manager, ...opts });

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
      assert.ok(` ${line} `.includes(` ${user} `), `expected ${user} in: ${line}`);
      assert.ok(` ${line} `.includes(" -e HOME=/app/.safe-home "), `expected HOME in: ${line}`);
    }
    // On Linux a root container leaves root-owned files the host user cannot
    // delete, so the sandbox would outlive the install.
    const mount = runs[0].match(/-v (\S+):\/app /);
    assert.ok(mount, `no /app mount in: ${runs[0]}`);
    const sandbox = mount[1];
    assert.equal(fs.existsSync(sandbox), false, "sandbox removed");
  });
}

// The image's pnpm hands off to the pinned version, and pnpm 8 and 9 fail every
// command when pnpm-workspace.yaml has no packages list ("packages field
// missing or empty"), so a Mac host must not get one for a project pinned to
// them. Needs the registry to download pnpm 9.
test("pnpm: a project pinned to pnpm 9 installs on a Mac host and keeps its package.json", { skip }, () => {
  const pkg = `${JSON.stringify(
    { name: "e2e", version: "1.0.0", private: true, packageManager: "pnpm@9.15.0" },
    null,
    2,
  )}\n`;
  const { r, proj, runs } = install("pnpm", { pkg, mac: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runs.length, 2, "fetch and build phases both ran");
  assert.ok(fs.existsSync(path.join(proj, "pnpm-lock.yaml")), "lockfile copied back");
  assert.equal(fs.readFileSync(path.join(proj, "package.json"), "utf8"), pkg);
  assert.ok(!fs.existsSync(path.join(proj, "pnpm-workspace.yaml")));
});

// A Yarn 4 project runs its pinned Yarn through corepack. Phase 1 fetches
// with --mode=skip-build, so the root postinstall must not have run when it
// ends; phase 2 builds offline and runs it. A second install finds the lockfile
// up to date. Needs the registry to download Yarn 4.18.1 and ms.
const hasFish = spawnSync("fish", ["--version"], { stdio: "ignore" }).status === 0;
for (const shell of ["bash", "fish"]) {
  const label = shell === "bash" ? "yarn" : "yarn (fish)";
  const shellSkip = skip || (shell === "fish" && !hasFish && "fish not available");
  test(`${label}: a Yarn 4 project with nodeLinker node-modules builds only in phase 2`, { skip: shellSkip }, () => {
    const pkg = JSON.stringify({
      name: "e2e",
      version: "1.0.0",
      private: true,
      packageManager: "yarn@4.18.1",
      dependencies: { ms: "2.1.3" },
      scripts: {
        postinstall: "node -e \"require('fs').writeFileSync('node_modules/.safe-built', '')\"",
      },
    });
    const { r, proj, runs, probeDir } = install("yarn", {
      pkg,
      shell,
      commands: [["install"], ["install"]],
      files: { ".yarnrc.yml": "nodeLinker: node-modules\nenableTelemetry: false\n" },
      probe:
        '[ -e "$src/node_modules/.safe-built" ] && touch "$out/built.$n"; [ -f "$src/yarn.lock" ] && cp "$src/yarn.lock" "$out/lock.$n"; [ "$n" = 1 ] && cp "$src/.safe-home/.yarnrc.yml" "$out/home-rc"',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(runs.length, 6, "fetch, audit and build, twice");
    assert.match(runs[0], / -e YARN_ENABLE_SCRIPTS=0 .* corepack yarn@4\.18\.1 install --mode=skip-build$/);
    assert.match(runs[1], / -e YARN_ENABLE_SCRIPTS=0 .* corepack yarn@4\.18\.1 npm audit/);
    assert.match(runs[2], / --network none .* corepack yarn@4\.18\.1 install --immutable/);
    assert.equal(
      fs.readFileSync(path.join(probeDir, "home-rc"), "utf8"),
      'networkSettings:\n  "github.com":\n    enableNetwork: false\n',
    );
    assert.ok(!fs.existsSync(path.join(probeDir, "built.1")), "postinstall ran in phase 1");
    assert.ok(!fs.existsSync(path.join(probeDir, "built.2")), "postinstall ran in the audit");
    assert.ok(fs.existsSync(path.join(probeDir, "built.3")), "postinstall did not run in phase 2");
    assert.ok(fs.existsSync(path.join(proj, "node_modules", "ms", "package.json")));
    assert.ok(fs.existsSync(path.join(proj, "node_modules", ".safe-built")));
    const lock = fs.readFileSync(path.join(proj, "yarn.lock"), "utf8");
    assert.match(lock, /^"ms@npm:2\.1\.3":/m);
    assert.equal(fs.readFileSync(path.join(probeDir, "lock.3"), "utf8"), lock);
    assert.equal(fs.readFileSync(path.join(probeDir, "lock.4"), "utf8"), lock, "second fetch changed yarn.lock");
  });
}
