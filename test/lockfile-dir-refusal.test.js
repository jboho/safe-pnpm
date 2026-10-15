const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { infoStubSh } = require("./helpers/docker-info-stub");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

// A lockfile directory set in the project config the wrappers copy into the
// sandbox would make phase 1 write the lockfile elsewhere, and the malware
// scan and audit would read the old one. pnpm 9 and 10 honor lockfile-dir in
// .npmrc, pnpm 10 and 11 honor lockfileDir in pnpm-workspace.yaml.
const ASSETS = path.join(__dirname, "..", "assets");

const available = (sh) =>
  spawnSync(sh, ["--version"], { stdio: "pipe" }).status === 0;

// [file, contents, key named in the refusal]
const REFUSED = [
  [".npmrc", "lockfile-dir=sub\n", "lockfile-dir"],
  [
    ".npmrc",
    "registry=https://r.example/\n  lockfile-dir = sub\n",
    "lockfile-dir",
  ],
  [".npmrc", "LOCKFILE-DIRECTORY=sub\n", "LOCKFILE-DIRECTORY"],
  [".npmrc", "shrinkwrap-directory=sub\n", "shrinkwrap-directory"],
  [
    "pnpm-workspace.yaml",
    "packages:\n  - a\nlockfileDir: sub\n",
    "lockfileDir",
  ],
  ["pnpm-workspace.yaml", "lockfileDir: sub\n", "lockfileDir"],
  ["pnpm-workspace.yaml", '{ "lockfileDir": sub }\n', "lockfileDir"],
];

// [file, contents]
const KEPT = [
  [".npmrc", "# lockfile-dir=sub\n"],
  [".npmrc", "; lockfile-dir=sub\nregistry=https://r.example/\n"],
  [".npmrc", "lockfile=false\n"],
  ["pnpm-workspace.yaml", "packages:\n  - a\n# lockfileDir: sub\n"],
  ["pnpm-workspace.yaml", "packages: [a] # lockfileDir: sub\n"],
];

const label = (file, contents) => `${file} ${JSON.stringify(contents)}`;

// A docker whose `info` succeeds and whose `run` is logged and fails, so a
// logged run shows the wrapper got as far as phase 1.
function project(file, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-lfdir-"));
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

function runShell(shell, mgr, { root, bin, proj }) {
  const script =
    shell === "fish"
      ? `source "${path.join(ASSETS, "_safe_pkg_prescan.fish")}"; source "${path.join(ASSETS, `${mgr}-wrapper.fish`)}"; cd "${proj}"; ${mgr} install </dev/null`
      : `source "${path.join(ASSETS, "_safe_pkg_shared.sh")}"; source "${path.join(ASSETS, `${mgr}-wrapper.sh`)}"; cd "${proj}"; ${mgr} install </dev/null`;
  const args =
    shell === "fish" ? ["--no-config", "-c", script] : ["-c", script];
  const r = spawnSync(shell, args, {
    stdio: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root },
  });
  return { status: r.status, err: r.stderr.toString() };
}

for (const shell of ["bash", "zsh", "fish"]) {
  const skip = available(shell) ? false : `${shell} not available`;
  for (const [file, contents, key] of REFUSED) {
    test(`${shell}: pnpm install with ${label(file, contents)} is refused before phase 1`, {
      skip,
    }, () => {
      const p = project(file, contents);
      try {
        const { status, err } = runShell(shell, "pnpm", p);
        assert.equal(status, 1, err);
        assert.ok(
          err.includes(
            `${path.basename(p.proj)}/${file} sets ${key}, so pnpm would write the lockfile`,
          ),
          err,
        );
        assert.deepEqual(p.runs(), []);
      } finally {
        fs.rmSync(p.root, { recursive: true, force: true });
      }
    });
  }
  for (const [file, contents] of KEPT) {
    test(`${shell}: pnpm install with ${label(file, contents)} reaches phase 1`, {
      skip,
    }, () => {
      const p = project(file, contents);
      try {
        const { err } = runShell(shell, "pnpm", p);
        assert.doesNotMatch(err, /so pnpm would write the lockfile/);
        assert.equal(p.runs().length, 1, err);
      } finally {
        fs.rmSync(p.root, { recursive: true, force: true });
      }
    });
  }
  // The check is pnpm's: npm does not read lockfile-dir.
  test(`${shell}: npm install with lockfile-dir in .npmrc reaches phase 1`, {
    skip,
  }, () => {
    const p = project(".npmrc", "lockfile-dir=sub\n");
    try {
      const { err } = runShell(shell, "npm", p);
      assert.doesNotMatch(err, /so pnpm would write the lockfile/);
      assert.equal(p.runs().length, 1, err);
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  });
}

test("fish: an out-of-date _safe_pkg_prescan.fish refuses instead of skipping the check", {
  skip: available("fish") ? false : "fish not available",
}, () => {
  const p = project(".npmrc", "registry=https://r.example/\n");
  try {
    const script = `source "${path.join(ASSETS, "_safe_pkg_prescan.fish")}"; functions -e _safe_pkg_lockfile_dir_setting; source "${path.join(ASSETS, "pnpm-wrapper.fish")}"; cd "${p.proj}"; pnpm install </dev/null`;
    const r = spawnSync("fish", ["--no-config", "-c", script], {
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${p.bin}:${process.env.PATH}`,
        HOME: p.root,
      },
    });
    const err = r.stderr.toString();
    assert.equal(r.status, 1, err);
    assert.match(err, /the lockfile-dir check failed; run safe-pnpm update/);
    assert.deepEqual(p.runs(), []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

// PowerShell: every case in one Linux pwsh container, one project dir each.
const skipPs1 = hasDocker ? false : "docker not available";
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1lf-"));
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
    ...REFUSED.map(([file, contents]) => ["pnpm", file, contents]),
    ...KEPT.map(([file, contents]) => ["pnpm", file, contents]),
    ["npm", ".npmrc", "lockfile-dir=sub\n"],
    ["stale", ".npmrc", "registry=https://r.example/\n"],
  ].map(([mgr, file, contents], i) => {
    const proj = path.join(root, `p${i}`);
    fs.mkdirSync(proj);
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "x", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(proj, file), contents);
    return { id: `c${i}`, mgr, dir: `/w/p${i}` };
  });
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(cases));
  const script = [
    "$env:PATH = '/w/bin:' + $env:PATH",
    '. "$HOME/.safe-pnpm/npm-wrapper.ps1"; . "$HOME/.safe-pnpm/pnpm-wrapper.ps1"',
    "foreach ($c in (Get-Content /w/cases.json -Raw | ConvertFrom-Json)) {",
    "  Set-Location $c.dir; $env:CASE = $c.id; $global:LASTEXITCODE = 0",
    "  if ($c.mgr -eq 'stale') {",
    "    $saved = (Get-Item function:_Safe_Pkg_Lockfile_Dir_Setting).ScriptBlock",
    "    Remove-Item function:_Safe_Pkg_Lockfile_Dir_Setting",
    "    $out = (pnpm install *>&1 | Out-String) -replace '\\r?\\n', ' '",
    "    Set-Item function:global:_Safe_Pkg_Lockfile_Dir_Setting -Value $saved",
    "  } else {",
    "    $out = (& $c.mgr install *>&1 | Out-String) -replace '\\r?\\n', ' '",
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
  const runs = (id) =>
    dockerLog.split("\n").filter((l) => l.startsWith(`${id} run `)).length;
  ps1Result = { get, runs, out: r.stdout + r.stderr };
  return ps1Result;
}

REFUSED.forEach(([file, contents, key], i) => {
  test(`ps1: pnpm install with ${label(file, contents)} is refused before phase 1`, {
    skip: skipPs1,
  }, () => {
    const { get, runs, out } = runPs1Cases();
    const r = get(`c${i}`);
    assert.ok(r, out);
    const text = r.slice(1).join("|");
    assert.equal(r[0], "1", text);
    assert.ok(
      text.includes(
        `/w/p${i}/${file} sets ${key}, so pnpm would write the lockfile`,
      ),
      text,
    );
    assert.equal(runs(`c${i}`), 0);
  });
});

KEPT.forEach(([file, contents], j) => {
  const i = REFUSED.length + j;
  test(`ps1: pnpm install with ${label(file, contents)} reaches phase 1`, {
    skip: skipPs1,
  }, () => {
    const { get, runs, out } = runPs1Cases();
    const r = get(`c${i}`);
    assert.ok(r, out);
    assert.doesNotMatch(
      r.slice(1).join("|"),
      /so pnpm would write the lockfile/,
    );
    assert.equal(runs(`c${i}`), 1, r.join("|"));
  });
});

test("ps1: npm install with lockfile-dir in .npmrc reaches phase 1", {
  skip: skipPs1,
}, () => {
  const { get, runs, out } = runPs1Cases();
  const i = REFUSED.length + KEPT.length;
  const r = get(`c${i}`);
  assert.ok(r, out);
  assert.doesNotMatch(r.slice(1).join("|"), /so pnpm would write the lockfile/);
  assert.equal(runs(`c${i}`), 1, r.join("|"));
});

test("ps1: a _safe_pkg_shared.ps1 without the lockfile-dir check refuses to install", {
  skip: skipPs1,
}, () => {
  const { get, runs, out } = runPs1Cases();
  const i = REFUSED.length + KEPT.length + 1;
  const r = get(`c${i}`);
  assert.ok(r, out);
  assert.equal(r[0], "1", r.join("|"));
  assert.match(
    r.slice(1).join("|"),
    /_safe_pkg_shared\.ps1 is missing or out of date/,
  );
  assert.equal(runs(`c${i}`), 0);
});
