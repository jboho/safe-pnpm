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
