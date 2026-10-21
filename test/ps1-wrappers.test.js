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
// pkg is the project's package.json text. win installs pnpm-arch.js and makes
// _Safe_Pkg_Host_Platform act as on a Windows x64 host. phase1 is sh the stub
// runs in phase 1, with $src = the /app mount. homeNpmrc is the user's
// ~/.npmrc.
function runPs1(manager, { env = {}, emptyId = false, noId = false, dockerInfo, auditRc = 0, pkg, win = false, phase1 = "", homeNpmrc } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, `${manager}-`));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const safe = path.join(root, "home", ".safe-pnpm");
  for (const d of [bin, proj, safe]) fs.mkdirSync(d, { recursive: true });
  const assets = ["_safe_pkg_shared.ps1", `${manager}-wrapper.ps1`, "link-check.js"];
  if (win) assets.push("pnpm-arch.js");
  for (const f of assets) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  // A scanner that always reports clean, so SAFE_PNPM_STRICT=1 (which also
  // blocks a scan that could not run) reaches the audit under test.
  fs.writeFileSync(path.join(safe, "malware-scan.js"), 'console.log("clean");\n');
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      infoStubSh(dockerInfo),
      'echo "$@" >> /w/docker.log',
      'echo "DOCKER $1" >> /w/events.log',
      'src=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && src="${a%%:/app}"; prev="$a"; done',
      "n=$(grep -c '' /w/docker.log)",
      'cp "$src/package.json" "/w/run$n.pkg"; [ -f "$src/pnpm-workspace.yaml" ] && cp "$src/pnpm-workspace.yaml" "/w/run$n.ws"',
      '[ -f "$src/.safe-home/.npmrc" ] && cp "$src/.safe-home/.npmrc" "/w/run$n.home"',
      `if [ "$n" = 1 ]; then mkdir -p "$src/node_modules/dep"; echo x > "$src/node_modules/dep/index.js"; echo resolved-by-phase-1 > "$src/${LOCKFILES[manager]}"; ${phase1} fi`,
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
      "echo >> /w/events.log",
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
    pkg ?? JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(proj, ".npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  if (homeNpmrc !== undefined) {
    fs.writeFileSync(path.join(root, "home", ".npmrc"), homeNpmrc);
  }
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const pathSetup = noId
    ? "$env:PATH = '/w/bin';"
    : "$env:PATH = '/w/bin:' + $env:PATH;";
  const winSetup = win
    ? "$hp = (Get-Item function:_Safe_Pkg_Host_Platform).ScriptBlock; function global:_Safe_Pkg_Host_Platform { param($Manager, $TmpDir, $Saved) & $hp -Manager $Manager -TmpDir $TmpDir -Saved $Saved -Os win32 -Cpu x64 };"
    : "";
  const script = `${pathSetup} . "$HOME/.safe-pnpm/${manager}-wrapper.ps1"; ${winSetup} Set-Location /w/proj; try { ${manager} install } catch { "THROWN: $($_.Exception.Message)" }; "RC=$LASTEXITCODE"`;
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

// Same check as two-phase.test.js: pnpm before 11.3 rejects --trust-lockfile.
test("ps1 pnpm: phase 2 passes trust-lockfile as --config.trust-lockfile=true", { skip }, () => {
  const { out, runs } = runPs1("pnpm");
  assert.equal(runs.length, 2, out);
  assert.match(runs[1], /--config\.trust-lockfile=true/);
  assert.doesNotMatch(runs[1], /(^|\s)--trust-lockfile/);
});

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

// pnpm 8 and 9 only read supportedArchitectures from package.json (see
// two-phase.test.js); the project's own package.json must come back unchanged.
test("ps1 pnpm: a pnpm 9 pin on Windows gets supportedArchitectures in the sandbox package.json only", { skip }, () => {
  const pkg = '{\n    "name": "x",\n    "packageManager": "pnpm@9.15.0"\n}';
  const { out, runs, proj, read } = runPs1("pnpm", { pkg, win: true });
  assert.match(out, /RC=0/);
  assert.equal(runs.length, 2, out);
  for (const n of [1, 2]) {
    assert.deepEqual(
      JSON.parse(read(`run${n}.pkg`)).pnpm.supportedArchitectures,
      { os: ["current", "win32"], cpu: ["current", "x64"] },
      `phase ${n}`,
    );
    assert.equal(read(`run${n}.ws`), "", `phase ${n}`);
  }
  assert.equal(fs.readFileSync(path.join(proj, "package.json"), "utf8"), pkg);
  assert.ok(!fs.existsSync(path.join(proj, "pnpm-workspace.yaml")));
});

test("ps1 pnpm: a failed supportedArchitectures restore blocks copy-back", { skip }, () => {
  const pkg = '{\n    "name": "x",\n    "packageManager": "pnpm@9.15.0"\n}';
  const { out, runs, proj } = runPs1("pnpm", {
    pkg,
    win: true,
    phase1: `echo '{' > "$src/package.json";`,
  });
  assert.match(out, /RC=1/);
  assert.equal(runs.length, 1, out);
  assert.match(out, /nothing copied back/);
  assert.equal(fs.readFileSync(path.join(proj, "package.json"), "utf8"), pkg);
  assert.ok(!fs.existsSync(path.join(proj, "node_modules")));
});

// See the ~/.npmrc tests in two-phase.test.js.
for (const manager of ["npm", "pnpm", "yarn"]) {
  test(`ps1 ${manager}: ~/.npmrc auth lines for a forwarded token reach phase 1 only`, { skip }, () => {
    const { out, runs, read } = runPs1(manager, {
      env: { NODE_AUTH_TOKEN: "SECRET-TOKEN-VALUE" },
      homeNpmrc: [
        "@acme:registry=https://registry.acme.example/",
        `//registry.acme.example/:_authToken=\${NODE_AUTH_TOKEN}`,
        `//npm.other.example/:_authToken=\${NPM_TOKEN}`,
        "//registry.npmjs.org/:_authToken=npm_LITERAL-HOME-TOKEN",
        "",
      ].join("\n"),
    });
    assert.match(out, /RC=0/);
    assert.equal(runs.length, 2, out);
    assert.equal(read("run1.home"), `//registry.acme.example/:_authToken=\${NODE_AUTH_TOKEN}\n`);
    assert.ok(runs[0].includes(" -e NPM_CONFIG_USERCONFIG=/app/.safe-home/.npmrc "), runs[0]);
    assert.equal(read("run2.home"), "", "the copy is gone before the build phase");
    assert.ok(!runs[1].includes("NPM_CONFIG_USERCONFIG"), runs[1]);
  });
}

test("ps1 npm: no qualifying ~/.npmrc line leaves the fetch phase unchanged", { skip }, () => {
  const { out, runs, read } = runPs1("npm", {
    env: { NODE_AUTH_TOKEN: "SECRET-TOKEN-VALUE" },
    homeNpmrc: "//registry.npmjs.org/:_authToken=npm_LITERAL-HOME-TOKEN\n",
  });
  assert.match(out, /RC=0/);
  assert.equal(read("run1.home"), "");
  assert.ok(!runs[0].includes("NPM_CONFIG_USERCONFIG"), runs[0]);
});
