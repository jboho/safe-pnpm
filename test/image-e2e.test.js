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
