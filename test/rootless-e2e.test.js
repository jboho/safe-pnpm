// Real installs under rootless Docker or Podman (issue 99). Runs only where
// SAFE_PNPM_ROOTLESS_E2E=1, which the CI rootless job sets after starting the
// daemon; there a failure to detect rootless mode fails the test instead of
// skipping it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ASSETS_DIR, wrapperInstall } = require("./helpers/wrapper-install");

const IMAGE = "safe-pnpm-rootless-test";
const skip = process.env.SAFE_PNPM_ROOTLESS_E2E === "1" ? false : "set SAFE_PNPM_ROOTLESS_E2E=1 under a rootless daemon";
// One small package with no dependencies of its own, so the copied-back
// node_modules holds files the containers wrote.
const PKG = `${JSON.stringify({
  name: "rootless-e2e",
  version: "1.0.0",
  private: true,
  dependencies: { "is-number": "7.0.0" },
})}\n`;

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-rootless-"));
  if (skip) return;
  const b = spawnSync("docker", ["build", "-q", "-t", IMAGE, ASSETS_DIR], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Every path under dir whose owner is not the test's own user.
function foreignOwned(dir) {
  const uid = process.getuid();
  const out = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.uid !== uid) out.push(`${p} (uid ${st.uid})`);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
  return out;
}

test("the wrapper detects the rootless daemon", { skip }, () => {
  const r = spawnSync("bash", ["-c", 'source "$SAFE_E2E_ASSETS/_safe_pkg_shared.sh"; _safe_pkg_docker_rootless'], {
    encoding: "utf8",
    env: { ...process.env, SAFE_E2E_ASSETS: ASSETS_DIR },
  });
  assert.equal(r.status, 0, `_safe_pkg_docker_rootless returned ${r.status}: ${r.stderr}`);
});

for (const [manager, commands, lockfile] of [
  ["pnpm", [["install"]], "pnpm-lock.yaml"],
  ["npm", [["install"], ["ci"]], "package-lock.json"],
]) {
  const label = commands.map((c) => `${manager} ${c.join(" ")}`).join(", then ");
  test(`${label}: containers keep their default user and the host user owns every copied-back file`, { skip }, () => {
    const { r, proj, runs } = wrapperInstall({ tmp, image: IMAGE, manager, commands, pkg: PKG });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(runs.length, 2 * commands.length, `fetch and build phases ran for each command:\n${runs.join("\n")}`);
    for (const line of runs) {
      assert.doesNotMatch(line, /(^| )--user /, `no --user under a rootless daemon: ${line}`);
      const mount = line.match(/-v (\S+):\/app /);
      assert.ok(mount, `no /app mount in: ${line}`);
      assert.equal(fs.existsSync(mount[1]), false, `sandbox ${mount[1]} removed`);
    }
    assert.ok(fs.existsSync(path.join(proj, lockfile)), "lockfile copied back");
    assert.ok(fs.existsSync(path.join(proj, "node_modules", "is-number", "package.json")), "dependency installed");
    assert.deepEqual(foreignOwned(proj), [], "files not owned by the host user");
  });
}
