const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");
const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;
const opts = { skip: !fishAvailable && "fish not installed" };

// Fish counterpart of test/hardening.test.js: a project dir plus a PATH dir
// holding stub `docker` and `npm`. The docker stub answers `info`, logs every
// other call's argv, then runs $dockerHook.
const sandbox = ({ auditRc = 0, dockerHook = "" } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-hardfish-"));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  for (const d of [bin, proj, path.join(home, ".safe-pnpm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // A scanner that always reports clean, so SAFE_PNPM_STRICT=1 (which also
  // blocks a scan that could not run) reaches the audit under test.
  fs.writeFileSync(path.join(home, ".safe-pnpm", "malware-scan.js"), 'console.log("clean");\n');
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "$@" >> "${root}/docker.log"\necho "DOCKER $1" >> "${root}/events.log"\n${dockerHook}\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\necho "AUDIT cwd=$PWD" >> "${root}/events.log"\ncat package-lock.json >> "${root}/events.log" 2>/dev/null\necho >> "${root}/events.log"\necho "audit-stub: 1 high severity vulnerability"\nexit ${auditRc}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(proj, "package.json"),
    '{"name":"x","version":"1.0.0"}',
  );
  fs.writeFileSync(path.join(proj, "package-lock.json"), "{}");
  fs.writeFileSync(
    path.join(proj, ".npmrc"),
    "//r.example/:_authToken=SECRET\n",
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    SAFE_PNPM_STRICT: "",
    SAFE_PNPM_MEMORY: "",
  };
  const events = () => {
    try {
      return fs.readFileSync(path.join(root, "events.log"), "utf8");
    } catch {
      return "";
    }
  };
  const dockerLog = () => {
    try {
      return fs.readFileSync(path.join(root, "docker.log"), "utf8");
    } catch {
      return "";
    }
  };
  return { root, proj, env, dockerLog, events };
};

const RUN = (proj) => `
source "${ASSETS_DIR}/_safe_pkg_prescan.fish"
source "${ASSETS_DIR}/npm-wrapper.fish"
cd "${proj}"
npm install
`;

const runFish = (sb, extraEnv = {}) =>
  spawnSync("fish", ["-c", RUN(sb.proj)], {
    cwd: sb.proj,
    env: { ...sb.env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

test("fish: audit failure shows output and continues by default", opts, () => {
  const sb = sandbox({ auditRc: 1 });
  const r = runFish(sb);
  assert.match(r.stderr, /audit-stub: 1 high severity/);
  assert.match(r.stderr, /audit failed or found issues — continuing in non-interactive mode/);
  assert.ok(sb.dockerLog().includes("install"), "install still ran");
});

test("fish: SAFE_PNPM_STRICT=1 blocks on audit failure before the build container", opts, () => {
  const sb = sandbox({ auditRc: 1 });
  const r = runFish(sb, { SAFE_PNPM_STRICT: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /audit-stub: 1 high severity/);
  assert.match(r.stderr, /npm audit failed or found issues\. Blocking \(SAFE_PNPM_STRICT=1\)/);
  assert.match(sb.events(), /^AUDIT /m, "audit ran");
  const runs = sb.dockerLog().split("\n").filter((l) => l.startsWith("run"));
  assert.equal(runs.length, 1, "only the fetch container started");
});

test("fish: audit runs after the fetch, before the build container", opts, () => {
  const sb = sandbox();
  runFish(sb);
  const order = sb
    .events()
    .split("\n")
    .filter((l) => /^(DOCKER run|AUDIT)/.test(l))
    .map((l) => (l.startsWith("DOCKER") ? "DOCKER:run" : "AUDIT"));
  assert.deepEqual(order, ["DOCKER:run", "AUDIT", "DOCKER:run"]);
});

test("fish: audit sees a package added by the fetch and never runs in the project", opts, () => {
  // Phase 1 stands in for `add left-pad`: it writes the new lockfile into the
  // sandbox mount, which the project's own lockfile never had.
  const hook =
    '[ "$1" = run ] && d=$(echo "$@" | sed -n "s/.*-v \\([^ ]*\\):\\/app.*/\\1/p") && echo \'{"added":"left-pad"}\' > "$d/package-lock.json"';
  const sb = sandbox({ dockerHook: hook });
  runFish(sb);
  const ev = sb.events();
  assert.match(ev, /left-pad/, "audit read the post-fetch lockfile");
  assert.ok(!ev.includes(`cwd=${sb.proj}\n`), "audit did not run in the project dir");
});

test("fish: both containers run with no-new-privileges and a pids limit", opts, () => {
  const sb = sandbox();
  runFish(sb);
  const runs = sb
    .dockerLog()
    .split("\n")
    .filter((l) => l.startsWith("run"));
  assert.equal(runs.length, 2, "fetch and build phases both ran");
  for (const line of runs) {
    assert.match(line, /--security-opt no-new-privileges/);
    assert.match(line, /--pids-limit 1024/);
    assert.doesNotMatch(line, /--memory/);
  }
});

test("fish: SAFE_PNPM_MEMORY adds a memory limit to both containers", opts, () => {
  const sb = sandbox();
  runFish(sb, { SAFE_PNPM_MEMORY: "2g" });
  const runs = sb
    .dockerLog()
    .split("\n")
    .filter((l) => l.startsWith("run"));
  assert.equal(runs.length, 2);
  for (const line of runs) assert.match(line, /--memory 2g/);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  test(`fish: ${sig} mid-install removes the sandbox dirs holding .npmrc`, opts, async () => {
    const sb = sandbox({ dockerHook: "sleep 30" });
    const child = spawn("fish", ["-c", RUN(sb.proj)], {
      cwd: sb.proj,
      env: sb.env,
      stdio: "ignore",
      detached: true,
    });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const deadline = Date.now() + 10000;
    while (!sb.dockerLog().includes("install")) {
      assert.ok(Date.now() < deadline, "docker stub never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    // The stub logs the sandbox as `-v DIR:/app`; mktemp ignores TMPDIR on
    // macOS, so read the path from there rather than listing a directory.
    const sandboxDir = sb.dockerLog().match(/-v (\S+):\/app/)[1];
    assert.ok(fs.existsSync(sandboxDir), "sandbox dir exists mid-install");
    assert.ok(fs.existsSync(path.join(sandboxDir, ".npmrc")));
    // Group signal, as a terminal's Ctrl-C delivers it.
    process.kill(-child.pid, sig);
    await exited;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(sandboxDir), false);
  });
}

test("fish: strip removes yarn-style and berry auth lines, keeps the rest", opts, () => {
  const sb = sandbox();
  const f = path.join(sb.root, ".yarnrc");
  fs.writeFileSync(
    f,
    [
      'registry "https://registry.yarnpkg.com"',
      '"//r.example/:_authToken" "SECRET"',
      "always-auth true",
      "npmAuthToken: SECRET",
      "npmAuthIdent: user:pass",
      'username "bob"',
      "",
    ].join("\n"),
  );
  spawnSync(
    "fish",
    [
      "-c",
      `source "${ASSETS_DIR}/_safe_pkg_prescan.fish"; _safe_pkg_strip_npmrc_auth "${f}"`,
    ],
    { env: sb.env },
  );
  const out = fs.readFileSync(f, "utf8");
  assert.doesNotMatch(out, /SECRET|pass|bob/);
  assert.match(out, /registry "https:\/\/registry.yarnpkg.com"/);
  assert.match(out, /always-auth true/);
});

// fish keeps running a wrapper after a signal until the foreground docker
// returns, so the wrapper-level signal tests above pass on its normal cleanup
// alone. This one hits the handler directly: a tracked dir must be gone once
// fish has processed the signal, with no wrapper finish to do it.
for (const sig of ["INT", "TERM"]) {
  test(`fish: a ${sig} removes tracked sandbox dirs via the handler`, opts, () => {
    const sb = sandbox();
    const r = spawnSync(
      "fish",
      [
        "-c",
        `source "${ASSETS_DIR}/_safe_pkg_prescan.fish"
set d (mktemp -d); set keep (mktemp -d)
_safe_pkg_track $d
kill -${sig} $fish_pid
sleep 0.3
test -e $d; and echo TRACKED-STILL-THERE; or echo TRACKED-GONE
test -e $keep; and echo UNTRACKED-KEPT
rm -rf $keep`,
      ],
      { env: sb.env, encoding: "utf8" },
    );
    assert.match(r.stdout, /TRACKED-GONE/);
    assert.match(r.stdout, /UNTRACKED-KEPT/);
  });
}
