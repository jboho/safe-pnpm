const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { infoStubSh } = require("./helpers/docker-info-stub");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

// With shared-workspace-lockfile=false each pnpm workspace member keeps its
// own lockfile and there is no root lockfile for the malware scan and audit to
// read, so pnpm installs are refused before phase 1, strict mode or not.
const ASSETS = path.join(__dirname, "..", "assets");
const REFUSAL = "so pnpm would keep a lockfile in each workspace member";

const available = (sh) =>
  spawnSync(sh, ["--version"], { stdio: "pipe" }).status === 0;

// [file, contents, install args, what the refusal names; a file-based name
// is prefixed with the project directory]
const REFUSED = [
  [
    ".npmrc",
    "shared-workspace-lockfile=false\n",
    [],
    "/.npmrc sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    'registry=https://r.example/\n  shared-workspace-lockfile = "false"\n',
    [],
    "/.npmrc sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "SHARED-WORKSPACE-SHRINKWRAP=false\n",
    [],
    "/.npmrc sets SHARED-WORKSPACE-SHRINKWRAP to false",
  ],
  [
    "pnpm-workspace.yaml",
    "packages:\n  - a\nsharedWorkspaceLockfile: false\n",
    [],
    "/pnpm-workspace.yaml sets sharedWorkspaceLockfile to false",
  ],
  [
    "pnpm-workspace.yaml",
    "shared-workspace-lockfile: false # per member\n",
    [],
    "/pnpm-workspace.yaml sets shared-workspace-lockfile to false",
  ],
  [
    "pnpm-workspace.yaml",
    '{ "sharedWorkspaceLockfile": false }\n',
    [],
    "/pnpm-workspace.yaml sets sharedWorkspaceLockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--no-shared-workspace-lockfile"],
    "--no-shared-workspace-lockfile sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--shared-workspace-lockfile=false"],
    "--shared-workspace-lockfile=false sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--shared-workspace-lockfile", "false"],
    "--shared-workspace-lockfile false sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--config.sharedWorkspaceLockfile=false"],
    "--config.sharedWorkspaceLockfile=false sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--config.shared-workspace-lockfile=false"],
    "--config.shared-workspace-lockfile=false sets shared-workspace-lockfile to false",
  ],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--shared-workspace-l=false"],
    "--shared-workspace-l=false sets shared-workspace-lockfile to false",
  ],
];

// [file, contents, install args]
const KEPT = [
  [".npmrc", "shared-workspace-lockfile=true\n", []],
  [".npmrc", "# shared-workspace-lockfile=false\n", []],
  [".npmrc", "; shared-workspace-lockfile=false\n", []],
  [
    "pnpm-workspace.yaml",
    "packages:\n  - a\nsharedWorkspaceLockfile: true\n",
    [],
  ],
  [
    "pnpm-workspace.yaml",
    "packages: [a] # sharedWorkspaceLockfile: false\n",
    [],
  ],
  [".npmrc", "registry=https://r.example/\n", ["--shared-workspace-lockfile"]],
  [
    ".npmrc",
    "registry=https://r.example/\n",
    ["--no-shared-workspace-lockfile=false"],
  ],
];

// A spelling the line check misses but pnpm still reads: the sandbox pins the
// shared lockfile on from the command line, which overrides config files.
const PINNED = [".npmrc", '"shared\\u002dworkspace-lockfile"=false\n'];
const PIN_FLAG = "--config.shared-workspace-lockfile=true";

const label = (file, contents, args) =>
  `${file} ${JSON.stringify(contents)}${args.length ? ` ${args.join(" ")}` : ""}`;

// A docker whose `info` succeeds and whose `run` is logged and fails, so a
// logged run shows the wrapper got as far as phase 1.
function project(file, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-unshared-"));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  fs.mkdirSync(bin);
  fs.mkdirSync(proj);
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\n${infoStubSh()}\necho "$@" >> "${root}/docker.log"\nexit 1\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  fs.writeFileSync(path.join(proj, file), contents);
  const runs = () => {
    try {
      return fs
        .readFileSync(path.join(root, "docker.log"), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("run "));
    } catch {
      return [];
    }
  };
  return { root, bin, proj, runs };
}

function runShell(shell, mgr, args, { root, bin, proj }, pre = "") {
  const words = ["install", ...args].map((a) => `'${a}'`).join(" ");
  const script =
    shell === "fish"
      ? `source "${path.join(ASSETS, "_safe_pkg_prescan.fish")}"; ${pre}source "${path.join(ASSETS, `${mgr}-wrapper.fish`)}"; cd "${proj}"; ${mgr} ${words} </dev/null`
      : `source "${path.join(ASSETS, "_safe_pkg_shared.sh")}"; source "${path.join(ASSETS, `${mgr}-wrapper.sh`)}"; cd "${proj}"; ${mgr} ${words} </dev/null`;
  const argv =
    shell === "fish" ? ["--no-config", "-c", script] : ["-c", script];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
  };
  delete env.SAFE_PNPM_OSV_STRICT;
  const r = spawnSync(shell, argv, { stdio: "pipe", env });
  return { status: r.status, err: r.stderr.toString() };
}

for (const shell of ["bash", "zsh", "fish"]) {
  const skip = available(shell) ? false : `${shell} not available`;
  for (const [file, contents, args, named] of REFUSED) {
    test(`${shell}: pnpm install with ${label(file, contents, args)} is refused before phase 1`, {
      skip,
    }, () => {
      const p = project(file, contents);
      try {
        const { status, err } = runShell(shell, "pnpm", args, p);
        assert.equal(status, 1, err);
        const what = named.startsWith("/")
          ? `${path.basename(p.proj)}${named}`
          : named;
        assert.ok(
          err.includes(
            `${what}, ${REFUSAL} and there is no root lockfile to scan.`,
          ),
          err,
        );
        assert.match(err, /Set shared-workspace-lockfile=true \(the default\)/);
        assert.match(err, /without the safety checks: command pnpm install/);
        assert.deepEqual(p.runs(), []);
      } finally {
        fs.rmSync(p.root, { recursive: true, force: true });
      }
    });
  }
  for (const [file, contents, args] of KEPT) {
    test(`${shell}: pnpm install with ${label(file, contents, args)} reaches phase 1`, {
      skip,
    }, () => {
      const p = project(file, contents);
      try {
        const { err } = runShell(shell, "pnpm", args, p);
        assert.ok(!err.includes(REFUSAL), err);
        assert.equal(p.runs().length, 1, err);
      } finally {
        fs.rmSync(p.root, { recursive: true, force: true });
      }
    });
  }
  test(`${shell}: pnpm install with ${label(...PINNED, [])} pins the shared lockfile on`, {
    skip,
  }, () => {
    const p = project(...PINNED);
    try {
      const { err } = runShell(shell, "pnpm", [], p);
      const runs = p.runs();
      assert.equal(runs.length, 1, err);
      assert.ok(runs[0].includes(` ${PIN_FLAG}`), runs[0]);
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  });
  // The setting is pnpm's: npm does not read it.
  test(`${shell}: npm install with shared-workspace-lockfile=false in .npmrc reaches phase 1`, {
    skip,
  }, () => {
    const p = project(".npmrc", "shared-workspace-lockfile=false\n");
    try {
      const { err } = runShell(shell, "npm", [], p);
      assert.ok(!err.includes(REFUSAL), err);
      assert.equal(p.runs().length, 1, err);
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  });
}

test("bash: the refusal holds under SAFE_PNPM_OSV_STRICT=1 too", {
  skip: available("bash") ? false : "bash not available",
}, () => {
  const p = project(".npmrc", "shared-workspace-lockfile=false\n");
  try {
    const script = `source "${path.join(ASSETS, "_safe_pkg_shared.sh")}"; source "${path.join(ASSETS, "pnpm-wrapper.sh")}"; cd "${p.proj}"; pnpm install </dev/null`;
    const r = spawnSync("bash", ["-c", script], {
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${p.bin}:${process.env.PATH}`,
        HOME: p.root,
        SAFE_PNPM_OSV_STRICT: "1",
      },
    });
    const err = r.stderr.toString();
    assert.equal(r.status, 1, err);
    assert.ok(err.includes(REFUSAL), err);
    assert.deepEqual(p.runs(), []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("fish: an out-of-date _safe_pkg_prescan.fish refuses instead of skipping the check", {
  skip: available("fish") ? false : "fish not available",
}, () => {
  const p = project(".npmrc", "registry=https://r.example/\n");
  try {
    const { status, err } = runShell(
      "fish",
      "pnpm",
      [],
      p,
      "functions -e _safe_pkg_unshared_lockfile_setting; ",
    );
    assert.equal(status, 1, err);
    assert.match(
      err,
      /the shared-workspace-lockfile check failed; run safe-pnpm update/,
    );
    assert.deepEqual(p.runs(), []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

// PowerShell: every case in one Linux pwsh container, one project dir each.
const skipPs1 = hasDocker ? false : "docker not available";
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1us-"));
  if (hasDocker) buildPwshImage();
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

let ps1Result;
function runPs1Cases() {
  if (ps1Result) return ps1Result;
  const root = fs.mkdtempSync(path.join(tmp, "w-"));
  const bin = path.join(root, "bin");
  const safe = path.join(root, "home", ".safe-pnpm");
  for (const d of [bin, safe]) fs.mkdirSync(d, { recursive: true });
  for (const f of [
    "_safe_pkg_shared.ps1",
    "npm-wrapper.ps1",
    "pnpm-wrapper.ps1",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\n${infoStubSh()}\necho "$CASE $*" >> /w/docker.log\nexit 1\n`,
    { mode: 0o755 },
  );
  const cases = [
    ...REFUSED.map(([file, contents, args]) => ["pnpm", file, contents, args]),
    ...KEPT.map(([file, contents, args]) => ["pnpm", file, contents, args]),
    ["npm", ".npmrc", "shared-workspace-lockfile=false\n", []],
    ["stale", ".npmrc", "registry=https://r.example/\n", []],
    ["pnpm", ...PINNED, []],
  ].map(([mgr, file, contents, args], i) => {
    const proj = path.join(root, `p${i}`);
    fs.mkdirSync(proj);
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "x", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(proj, file), contents);
    return { id: `c${i}`, mgr, dir: `/w/p${i}`, args: ["install", ...args] };
  });
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(cases));
  const script = [
    "$env:PATH = '/w/bin:' + $env:PATH",
    "Remove-Item env:SAFE_PNPM_OSV_STRICT -ErrorAction SilentlyContinue",
    '. "$HOME/.safe-pnpm/npm-wrapper.ps1"; . "$HOME/.safe-pnpm/pnpm-wrapper.ps1"',
    "foreach ($c in (Get-Content /w/cases.json -Raw | ConvertFrom-Json)) {",
    "  Set-Location $c.dir; $env:CASE = $c.id; $global:LASTEXITCODE = 0; $a = @($c.args)",
    "  if ($c.mgr -eq 'stale') {",
    "    $saved = (Get-Item function:_Safe_Pkg_Unshared_Lockfile_Setting).ScriptBlock",
    "    Remove-Item function:_Safe_Pkg_Unshared_Lockfile_Setting",
    "    $out = (& { try { pnpm @a } catch { \"THROWN: $($_.Exception.Message)\" } } *>&1 | Out-String) -replace '\\r?\\n', ' '",
    "    Set-Item function:global:_Safe_Pkg_Unshared_Lockfile_Setting -Value $saved",
    "  } else {",
    "    $out = (& { try { & $c.mgr @a } catch { \"THROWN: $($_.Exception.Message)\" } } *>&1 | Out-String) -replace '\\r?\\n', ' '",
    "  }",
    '  "RUN|$($c.id)|$LASTEXITCODE|$out"',
    "}",
  ].join("\n");
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/w/home",
      "-v",
      `${root}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-Command",
      script,
    ],
    { encoding: "utf8" },
  );
  const lines = (r.stdout || "").split("\n");
  const get = (id) => {
    const line = lines.find((l) => l.startsWith(`RUN|${id}|`));
    return line ? line.split("|").slice(2) : undefined;
  };
  let dockerLog = "";
  try {
    dockerLog = fs.readFileSync(path.join(root, "docker.log"), "utf8");
  } catch {}
  const runLines = (id) =>
    dockerLog.split("\n").filter((l) => l.startsWith(`${id} run `));
  ps1Result = { get, runLines, out: r.stdout + r.stderr };
  return ps1Result;
}

REFUSED.forEach(([file, contents, args, named], i) => {
  test(`ps1: pnpm install with ${label(file, contents, args)} is refused before phase 1`, {
    skip: skipPs1,
  }, () => {
    const { get, runLines, out } = runPs1Cases();
    const r = get(`c${i}`);
    assert.ok(r, out);
    const text = r.slice(1).join("|");
    assert.equal(r[0], "1", text);
    const what = named.startsWith("/") ? `/w/p${i}${named}` : named;
    assert.ok(text.includes(`${what}, ${REFUSAL}`), text);
    assert.match(text, /without the safety checks: pnpm\.cmd install/);
    assert.equal(runLines(`c${i}`).length, 0);
  });
});

KEPT.forEach(([file, contents, args], j) => {
  const i = REFUSED.length + j;
  test(`ps1: pnpm install with ${label(file, contents, args)} reaches phase 1`, {
    skip: skipPs1,
  }, () => {
    const { get, runLines, out } = runPs1Cases();
    const r = get(`c${i}`);
    assert.ok(r, out);
    assert.ok(!r.slice(1).join("|").includes(REFUSAL), r.join("|"));
    assert.equal(runLines(`c${i}`).length, 1, r.join("|"));
  });
});

test("ps1: npm install with shared-workspace-lockfile=false in .npmrc reaches phase 1", {
  skip: skipPs1,
}, () => {
  const { get, runLines, out } = runPs1Cases();
  const i = REFUSED.length + KEPT.length;
  const r = get(`c${i}`);
  assert.ok(r, out);
  assert.ok(!r.slice(1).join("|").includes(REFUSAL), r.join("|"));
  assert.equal(runLines(`c${i}`).length, 1, r.join("|"));
});

test("ps1: a _safe_pkg_shared.ps1 without the shared-workspace-lockfile check refuses to install", {
  skip: skipPs1,
}, () => {
  const { get, runLines, out } = runPs1Cases();
  const i = REFUSED.length + KEPT.length + 1;
  const r = get(`c${i}`);
  assert.ok(r, out);
  assert.equal(r[0], "1", r.join("|"));
  assert.match(
    r.slice(1).join("|"),
    /_safe_pkg_shared\.ps1 is missing or out of date/,
  );
  assert.equal(runLines(`c${i}`).length, 0);
});

test(`ps1: pnpm install with ${label(...PINNED, [])} pins the shared lockfile on`, {
  skip: skipPs1,
}, () => {
  const { get, runLines, out } = runPs1Cases();
  const i = REFUSED.length + KEPT.length + 2;
  const r = get(`c${i}`);
  assert.ok(r, out);
  const lines = runLines(`c${i}`);
  assert.equal(lines.length, 1, r.join("|"));
  assert.ok(lines[0].includes(` ${PIN_FLAG}`), lines[0]);
});
