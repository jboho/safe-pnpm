const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

const shellAvailable = (sh) =>
  spawnSync(sh, ["--version"], { stdio: "pipe" }).status === 0;
const SHELLS = ["bash", "zsh"].filter(shellAvailable);

// A project dir plus a PATH dir holding stub `docker` and `npm`. The docker
// stub answers `info`, logs every other call's argv, then runs $DOCKER_HOOK.
// The npm stub stands in for `npm audit`.
const sandbox = ({ auditRc = 0, dockerHook = "" } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-hard-"));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  for (const d of [bin, proj, path.join(home, ".safe-pnpm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    fs.copyFileSync(path.join(ASSETS_DIR, f), path.join(home, ".safe-pnpm", f));
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "$@" >> "${root}/docker.log"\n${dockerHook}\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\necho "audit-stub: 1 high severity vulnerability"\nexit ${auditRc}\n`,
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
  const dockerLog = () => {
    try {
      return fs.readFileSync(path.join(root, "docker.log"), "utf8");
    } catch {
      return "";
    }
  };
  return { root, proj, env, dockerLog };
};

const RUN =
  'source "$HOME/.safe-pnpm/_safe_pkg_shared.sh"; _safe_pkg_dispatch npm package-lock.json "" "package.json .npmrc" install';

for (const shell of SHELLS) {
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
    assert.ok(sb.dockerLog().includes("install"), "install still ran");
  });

  test(`SAFE_PNPM_STRICT=1 blocks on audit failure before any container (${shell})`, () => {
    const sb = sandbox({ auditRc: 1 });
    const r = spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: { ...sb.env, SAFE_PNPM_STRICT: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Blocking \(SAFE_PNPM_STRICT=1\)/);
    assert.equal(sb.dockerLog(), "", "no container started");
  });

  test(`both containers run with no-new-privileges and a pids limit (${shell})`, () => {
    const sb = sandbox();
    spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: sb.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runs = sb
      .dockerLog()
      .split("\n")
      .filter((l) => l.startsWith("run"));
    assert.ok(runs.length >= 1);
    for (const line of runs) {
      assert.match(line, /--security-opt no-new-privileges/);
      assert.match(line, /--pids-limit 1024/);
      assert.doesNotMatch(line, /--memory/);
    }
  });

  test(`SAFE_PNPM_MEMORY adds a memory limit (${shell})`, () => {
    const sb = sandbox();
    spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: { ...sb.env, SAFE_PNPM_MEMORY: "2g" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(sb.dockerLog(), /--memory 2g/);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    test(`${sig} mid-install removes the sandbox dirs holding .npmrc (${shell})`, async () => {
      const sb = sandbox({ dockerHook: "sleep 30" });
      const child = spawn(shell, ["-c", RUN], {
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

  test(`strip removes yarn-style and berry auth lines, keeps the rest (${shell})`, () => {
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
      shell,
      [
        "-c",
        `source "$HOME/.safe-pnpm/_safe_pkg_shared.sh"; _safe_pkg_strip_npmrc_auth "${f}"`,
      ],
      { env: sb.env },
    );
    const out = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(out, /SECRET|pass|bob/);
    assert.match(out, /registry "https:\/\/registry.yarnpkg.com"/);
    assert.match(out, /always-auth true/);
  });
}
