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
  // A scanner that always reports clean, so SAFE_PNPM_STRICT=1 (which also
  // blocks a scan that could not run) reaches the audit under test.
  fs.writeFileSync(
    path.join(home, ".safe-pnpm", "malware-scan.js"),
    'console.log("clean");\n',
  );
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

const RUN =
  'source "$HOME/.safe-pnpm/_safe_pkg_shared.sh"; _safe_pkg_dispatch npm package-lock.json "" "package.json package-lock.json .npmrc" install';

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

  test(`SAFE_PNPM_STRICT=1 blocks on audit failure before the build container (${shell})`, () => {
    const sb = sandbox({ auditRc: 1 });
    const r = spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: { ...sb.env, SAFE_PNPM_STRICT: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(r.status, 0);
    assert.match(sb.events(), /^AUDIT /m, "audit ran");
    assert.match(
      r.stderr,
      /audit failed or found issues\. Blocking \(SAFE_PNPM_STRICT=1\)/,
    );
    const runs = sb
      .dockerLog()
      .split("\n")
      .filter((l) => l.startsWith("run"));
    assert.equal(runs.length, 1, "only the fetch container started");
  });

  test(`audit runs after the fetch, before the build container (${shell})`, () => {
    const sb = sandbox();
    spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: sb.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const order = sb
      .events()
      .split("\n")
      .filter((l) => /^(DOCKER run|AUDIT)/.test(l))
      .map((l) => l.split(" ")[0] + (l.startsWith("DOCKER") ? ":run" : ""));
    // On a Mac, npm adds a container between the audit and the build (host
    // platform packages), so only the ends and the audit's place are fixed.
    assert.equal(order[0], "DOCKER:run");
    assert.equal(order[1], "AUDIT");
    assert.ok(order.length >= 3, "build container ran after the audit");
    assert.equal(order.at(-1), "DOCKER:run");
  });

  test(`audit sees a package added by the fetch and never runs in the project (${shell})`, () => {
    // Phase 1 stands in for `add left-pad`: it writes the new lockfile into
    // the sandbox mount, which the project's own lockfile never had.
    const hook =
      '[ "$1" = run ] && d=$(echo "$@" | sed -n "s/.*-v \\([^ ]*\\):\\/app.*/\\1/p") && echo \'{"added":"left-pad"}\' > "$d/package-lock.json"';
    const sb = sandbox({ dockerHook: hook });
    spawnSync(shell, ["-c", RUN], {
      cwd: sb.proj,
      env: sb.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ev = sb.events();
    assert.match(ev, /left-pad/, "audit read the post-fetch lockfile");
    assert.doesNotMatch(
      ev,
      new RegExp(`cwd=${sb.proj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      "audit did not run in the project dir",
    );
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
