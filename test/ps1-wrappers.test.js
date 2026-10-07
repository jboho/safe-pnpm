const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");
const {
  ROOTLESS_DOCKER,
  PODMAN_CLI,
  PODMAN_CLI_NOT_ROOTLESS,
  WRONG_CASE_ROOTLESS,
  ROOTFUL_DOCKER_HOST_TRUE,
  UNREADABLE,
  infoStubSh,
} = require("./helpers/docker-info-stub");

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
// emptyId puts an `id` on PATH that prints nothing, like a shadowed one.
// noId leaves only /w/bin (the docker stub) on PATH, so no `id` resolves.
// dockerInfo sets the stub's answers to the `docker info --format` rootless
// queries (see helpers/docker-info-stub.js).
function runPs1(manager, { env = {}, emptyId = false, noId = false, dockerInfo, auditRc = 0 } = {}) {
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
      infoStubSh(dockerInfo),
      'echo "$@" >> /w/docker.log',
      'echo "DOCKER $1" >> /w/events.log',
      'src=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && src="${a%%:/app}"; prev="$a"; done',
      "n=$(grep -c '' /w/docker.log)",
      `if [ "$n" = 1 ]; then mkdir -p "$src/node_modules/dep"; echo x > "$src/node_modules/dep/index.js"; echo resolved-by-phase-1 > "$src/${LOCKFILES[manager]}"; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // Stands in for `<manager> audit`; logs where it ran and what lockfile it saw.
  fs.writeFileSync(
    path.join(bin, manager),
    [
      "#!/bin/sh",
      'echo "AUDIT cwd=$PWD" >> /w/events.log',
      `cat ${LOCKFILES[manager]} >> /w/events.log 2>/dev/null`,
      'echo "audit-stub: 1 high severity vulnerability"',
      `exit ${auditRc}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  if (emptyId) {
    fs.writeFileSync(path.join(bin, "id"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(proj, ".npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const pathSetup = noId
    ? "$env:PATH = '/w/bin';"
    : "$env:PATH = '/w/bin:' + $env:PATH;";
  const script = `${pathSetup} . "$HOME/.safe-pnpm/${manager}-wrapper.ps1"; Set-Location /w/proj; ${manager} install; "RC=$LASTEXITCODE"`;
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
      assert.ok(` ${line} `.includes(` ${user} `), `expected ${user} in: ${line}`);
      assert.ok(` ${line} `.includes(" -e HOME=/app/.safe-home "), `expected HOME in: ${line}`);
    }
    assert.ok(
      fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")),
      "copy-back ran",
    );
  });
}

for (const manager of ["npm", "pnpm", "yarn"]) {
  test(`ps1 ${manager}: audit runs after the fetch, before the build container`, { skip }, () => {
    const { out, read } = runPs1(manager);
    const order = read("events.log")
      .split("\n")
      .filter((l) => /^(DOCKER run|AUDIT)/.test(l))
      .map((l) => (l.startsWith("DOCKER") ? "DOCKER:run" : "AUDIT"));
    assert.deepEqual(order, ["DOCKER:run", "AUDIT", "DOCKER:run"], out);
  });

  test(`ps1 ${manager}: audit reads the post-fetch lockfile, outside the project`, { skip }, () => {
    const { out, read } = runPs1(manager);
    const ev = read("events.log");
    assert.match(ev, /resolved-by-phase-1/, out);
    assert.ok(!ev.includes("cwd=/w/proj\n"), "audit did not run in the project dir");
  });

  test(`ps1 ${manager}: SAFE_PNPM_STRICT=1 blocks on audit failure before the build container`, { skip }, () => {
    const { out, runs, read } = runPs1(manager, { auditRc: 1, env: { SAFE_PNPM_STRICT: "1" } });
    // Strict also blocks on a failed OSV scan, so require the audit's own text.
    assert.match(read("events.log"), /^AUDIT /m, "audit ran");
    assert.match(out, /audit failed or found issues\. Blocking \(SAFE_PNPM_STRICT=1\)/, out);
    assert.doesNotMatch(out, /RC=0/, out);
    assert.equal(runs.length, 1, "only the fetch container started");
  });
}

// All three wrappers call the same _Safe_Pkg_User, so these run on npm only.
for (const [label, dockerInfo] of [
  ["rootless Docker", ROOTLESS_DOCKER],
  ["the Podman CLI", PODMAN_CLI],
]) {
  test(`ps1 npm: ${label} keeps the default container user`, { skip }, () => {
    const { out, runs } = runPs1("npm", { dockerInfo });
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    for (const line of runs) {
      assert.ok(!` ${line} `.includes(" --user "), `unexpected --user in: ${line}`);
      assert.ok(!line.includes("HOME=/app/.safe-home"), `unexpected HOME in: ${line}`);
    }
  });
}

// PowerShell's -like and -eq ignore case, so the match must be case-sensitive
// to agree with the sh and fish helpers.
for (const [label, dockerInfo] of [
  ["a wrong-case SecurityOptions element", WRONG_CASE_ROOTLESS],
  ["the Podman CLI answering false", PODMAN_CLI_NOT_ROOTLESS],
  ["a rootful daemon while the Podman query says true", ROOTFUL_DOCKER_HOST_TRUE],
  ["an unreadable daemon", UNREADABLE],
]) {
  test(`ps1 npm: ${label} is not rootless`, { skip }, () => {
    const { out, runs } = runPs1("npm", { dockerInfo });
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    const user = `--user ${process.getuid()}:${process.getgid()}`;
    for (const line of runs) {
      assert.ok(` ${line} `.includes(` ${user} `), `expected ${user} in: ${line}`);
      assert.ok(` ${line} `.includes(" -e HOME=/app/.safe-home "), `expected HOME in: ${line}`);
    }
  });
}

test("ps1 npm: an unreadable uid still refuses under rootless Docker", { skip }, () => {
  const { out, runs, proj } = runPs1("npm", { emptyId: true, dockerInfo: ROOTLESS_DOCKER });
  assert.equal(runs.length, 0, out);
  assert.match(out, /could not read your user id/);
  assert.match(out, /RC=1/);
  assert.ok(!fs.existsSync(path.join(proj, "node_modules")), "nothing copied back");
});

for (const manager of ["npm", "pnpm", "yarn"]) {
  test(`ps1 ${manager}: an unreadable uid refuses the install before any container`, { skip }, () => {
    const { out, runs, proj } = runPs1(manager, { emptyId: true });
    assert.equal(runs.length, 0, out);
    assert.match(out, /could not read your user id/);
    assert.match(out, /RC=1/);
    assert.ok(!fs.existsSync(path.join(proj, "node_modules")), "nothing copied back");
  });
}

test("ps1: a missing id refuses with the safe-pnpm message", { skip }, () => {
  const { out, runs } = runPs1("npm", { noId: true });
  assert.equal(runs.length, 0, out);
  assert.match(out, /could not read your user id/);
  assert.match(out, /RC=1/);
  assert.doesNotMatch(out, /is not recognized/);
});

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
