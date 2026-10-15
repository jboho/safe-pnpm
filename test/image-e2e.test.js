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
// opts.pkg replaces the project's package.json text; opts.mac puts a `uname`
// reporting Darwin arm64 in front, so the macOS host path runs on any host.
function install(manager, opts = {}) {
  const root = fs.mkdtempSync(path.join(tmp, `${manager}-`));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  for (const d of [bin, proj, path.join(home, ".safe-pnpm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of ["link-check.js", "pnpm-arch.js"]) {
    fs.copyFileSync(path.join(ASSETS_DIR, f), path.join(home, ".safe-pnpm", f));
  }
  if (opts.mac) {
    fs.writeFileSync(
      path.join(bin, "uname"),
      '#!/bin/sh\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n',
      { mode: 0o755 },
    );
  }
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
    opts.pkg ??
      JSON.stringify({ name: "e2e", version: "1.0.0", private: true }),
  );
  // Paths go in through the environment, not the script text or argv, so a
  // TMPDIR containing quotes or `$` can't change what bash runs. CodeQL
  // counts every `bash -c` argv element as command text, so argv isn't enough.
  const script =
    'source "$SAFE_E2E_ASSETS/_safe_pkg_shared.sh"; source "$SAFE_E2E_ASSETS/$SAFE_E2E_MANAGER-wrapper.sh"; cd "$SAFE_E2E_PROJ"; "$SAFE_E2E_MANAGER" install </dev/null';
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      SAFE_E2E_ASSETS: ASSETS_DIR,
      SAFE_E2E_MANAGER: manager,
      SAFE_E2E_PROJ: proj,
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
