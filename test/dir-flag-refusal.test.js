const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

// Flags that point an install at another directory (issue #56). The scan
// reads this directory's lockfile, so the wrappers refuse them on every
// command they scan. Each spelling was checked against the managers' own
// parsers (npm 10.9, pnpm 9.15 and 10.33, yarn 1.22). pnpm rejects
// --lockfile-d and --lockfile-di as ambiguous; the wrappers refuse them anyway.
const ASSETS = path.join(__dirname, "..", "assets");
const SHARED = path.join(ASSETS, "_safe_pkg_shared.sh");
const PRESCAN = path.join(ASSETS, "_safe_pkg_prescan.fish");

const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;
const zshAvailable = spawnSync("zsh", ["-c", "true"]).status === 0;

const REFUSED = [
  ["npm", ["--prefix", "web", "install"]],
  ["npm", ["install", "--prefix", "web"]],
  ["npm", ["install", "--prefix=web"]],
  ["npm", ["--prefix=web", "ci"]],
  ["npm", ["-C", "web", "install"]],
  ["npm", ["install", "-C", "web"]],
  ["npm", ["install", "-C=web"]],
  ["npm", ["install", "-DC", "web", "x"]],
  ["npm", ["install", "--prefi", "web"]],
  ["npm", ["install", "--prefi=web"]],
  ["npm", ["uninstall", "--prefix", "web", "x"]],
  // A directory named like a command must not end the search for one.
  ["npm", ["-C", "docs", "install"]],
  ["npm", ["-C", "test", "install"]],
  ["npm", ["--prefix", "bin", "install"]],
  // nopt strips any number of dashes, then tries a cluster of short flags.
  ["npm", ["--C", "web", "install"]],
  ["npm", ["install", "--DC", "web", "x"]],
  ["npm", ["install", "-prefix=web"]],
  ["npm", ["---prefix", "web", "install"]],
  ["npm", ["-prefix", "test", "install"]],
  ["pnpm", ["-C", "web", "install"]],
  ["pnpm", ["install", "-C", "web"]],
  ["pnpm", ["install", "-C=web"]],
  ["pnpm", ["add", "-DC", "web", "x"]],
  ["pnpm", ["-rC", "web", "add", "x"]],
  ["pnpm", ["--dir", "web", "install"]],
  ["pnpm", ["install", "--dir=web"]],
  ["pnpm", ["install", "--prefix", "web"]],
  ["pnpm", ["--prefix=web", "install"]],
  ["pnpm", ["install", "--prefi", "web"]],
  ["pnpm", ["install", "--lockfile-dir", "web"]],
  ["pnpm", ["install", "--lockfile-di=web"]],
  ["pnpm", ["install", "--lockfile-d", "web"]],
  ["pnpm", ["--config.dir=web", "install"]],
  ["pnpm", ["install", "--config.prefix=web"]],
  ["pnpm", ["install", "--config.lockfile-dir=web"]],
  ["pnpm", ["install", "--config.lockfileDir=web"]],
  ["pnpm", ["install", "--config.lockfile_dir=web"]],
  ["pnpm", ["fetch", "-C", "web"]],
  ["pnpm", ["remove", "--dir", "web", "x"]],
  ["pnpm", ["--prefix", "server", "install"]],
  ["pnpm", ["--prefix", "test", "install"]],
  ["pnpm", ["-C", "--dir", "server", "install"]],
  ["pnpm", ["--reporter", "--dir", "server", "install"]],
  // Older names pnpm still maps to lockfile-dir.
  ["pnpm", ["install", "--lockfile-directory", "../other"]],
  ["pnpm", ["add", "x", "--lockfile-directory=../other"]],
  ["pnpm", ["install", "--shrinkwrap-directory=../other"]],
  ["pnpm", ["install", "--lockfile-dire", "web"]],
  ["pnpm", ["install", "--lockfile-direc", "web"]],
  ["pnpm", ["install", "--lockfile-direct", "web"]],
  ["pnpm", ["install", "--lockfile-directo", "web"]],
  ["pnpm", ["install", "--lockfile-director", "web"]],
  ["pnpm", ["--C", "web", "install"]],
  ["pnpm", ["add", "--DC", "web", "x"]],
  ["pnpm", ["-dir", "web", "install"]],
  ["pnpm", ["install", "-prefix=web"]],
  ["pnpm", ["---dir", "web", "install"]],
  ["pnpm", ["install", "-lockfile-dir=web"]],
  ["yarn", ["--cwd", "web", "install"]],
  ["yarn", ["install", "--cwd", "web"]],
  ["yarn", ["install", "--cwd=web"]],
  ["yarn", ["--cwd", "web"]],
  ["yarn", ["--cwd=web"]],
  ["yarn", ["--cwd", "web", "add", "x"]],
  ["yarn", ["add", "--cwd", "web", "x"]],
];

// Scanned commands whose flags do not change the directory.
const KEPT = [
  ["npm", ["install"]],
  ["npm", ["install", "--prefer-offline"]],
  ["npm", ["install", "--workspace", "web", "x"]],
  ["npm", ["install", "--cache", "/c"]],
  ["npm", ["install", "--Prefix=web"]],
  ["npm", ["install", "x", "--", "--prefix"]],
  ["npm", ["--", "install", "x"]],
  ["npm", ["install", "--pref", "web"]],
  ["npm", ["install", "--//r.example/Corp/:_authToken=t"]],
  ["pnpm", ["install", "--lockfile-only"]],
  ["pnpm", ["add", "--filter", "web", "x"]],
  ["pnpm", ["install", "--config.store-dir=/s"]],
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["add", "x", "--", "-C"]],
  ["pnpm", ["--", "install", "x"]],
  ["pnpm", ["install", "--config.childConcurrency=2"]],
  ["yarn", ["add", "-C", "x"]],
  ["yarn", ["install", "--frozen-lockfile"]],
  ["yarn", ["add", "x", "--", "--cwd"]],
];

// Not scanned, so the flags are the manager's business.
const PASS_THROUGH = [
  ["pnpm", ["-C", "web", "run", "build"]],
  ["pnpm", ["--dir", "web", "test"]],
  ["pnpm", ["--prefix=web", "exec", "tsc"]],
  ["npm", ["--prefix", "web", "run", "build"]],
  ["npm", ["-C", "web", "test"]],
  ["yarn", ["--cwd", "web", "run", "build"]],
  ["yarn", ["--cwd=web", "test"]],
];

const label = (mgr, args) => `${mgr} ${args.join(" ")}`;

for (const [list, expected] of [
  [REFUSED, 0],
  [KEPT, 1],
]) {
  for (const [mgr, args] of list) {
    test(`sh: _safe_pkg_dir_flag ${label(mgr, args)} -> ${expected}`, () => {
      for (const shell of zshAvailable ? ["bash", "zsh"] : ["bash"]) {
        const r = spawnSync(
          shell,
          [
            "-c",
            'source "$1"; shift; _safe_pkg_dir_flag "$@"',
            shell,
            SHARED,
            mgr,
            ...args,
          ],
          { stdio: "pipe" },
        );
        assert.equal(r.status, expected, shell);
      }
    });
    test(`fish: _safe_pkg_dir_flag ${label(mgr, args)} -> ${expected}`, {
      skip: !fishAvailable,
    }, () => {
      const r = spawnSync(
        "fish",
        [
          "-c",
          "source $argv[1]; _safe_pkg_dir_flag $argv[2..-1]",
          PRESCAN,
          mgr,
          ...args,
        ],
        { stdio: "pipe" },
      );
      assert.equal(r.status, expected);
    });
  }
}

// Wrapper sandbox: a docker that records every call, and a native manager
// that prints NATIVE, so a refusal, a scan and a pass-through can be told apart.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-dirflag-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\necho "$@" >> "${dir}/docker.log"\nexit 1\n`,
    { mode: 0o755 },
  );
  for (const mgr of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(path.join(bin, mgr), '#!/bin/sh\necho "NATIVE $*"\n', {
      mode: 0o755,
    });
  }
  return { dir, bin };
}

const env = (dir, bin) => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HOME: dir,
});

const runSh = (dir, bin, mgr, args) =>
  spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; source "$2"; shift 2; "$@"',
      "bash",
      SHARED,
      path.join(ASSETS, `${mgr}-wrapper.sh`),
      mgr,
      ...args,
    ],
    { stdio: "pipe", cwd: dir, env: env(dir, bin) },
  );

// Installed the way setup installs them: fish autoloads the wrapper and
// _safe_pkg_prescan.fish from a functions dir, and nothing sources them.
const runFish = (dir, bin, mgr, args) => {
  const fnDir = path.join(dir, "functions");
  fs.mkdirSync(fnDir, { recursive: true });
  fs.copyFileSync(PRESCAN, path.join(fnDir, "_safe_pkg_prescan.fish"));
  fs.copyFileSync(
    path.join(ASSETS, `${mgr}-wrapper.fish`),
    path.join(fnDir, `${mgr}.fish`),
  );
  return spawnSync(
    "fish",
    [
      "--no-config",
      "-c",
      "set -p fish_function_path $argv[1]; $argv[2..-1]",
      fnDir,
      mgr,
      ...args,
    ],
    { stdio: "pipe", cwd: dir, env: env(dir, bin) },
  );
};

for (const [shell, run, skip] of [
  ["sh", runSh, false],
  ["fish", runFish, !fishAvailable],
]) {
  for (const [mgr, args] of REFUSED) {
    test(`${shell}: ${label(mgr, args)} is refused before docker is called`, {
      skip,
    }, () => {
      const { dir, bin } = sandbox();
      try {
        const r = run(dir, bin, mgr, args);
        const err = r.stderr.toString();
        assert.equal(r.status, 1, err);
        assert.match(err, /is not supported through the wrapper/);
        assert.match(err, /cd into that directory/);
        assert.match(err, new RegExp(`command ${mgr} `));
        assert.doesNotMatch(r.stdout.toString(), /NATIVE/);
        assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  for (const [mgr, args] of PASS_THROUGH) {
    test(`${shell}: ${label(mgr, args)} passes through to native ${mgr}`, {
      skip,
    }, () => {
      const { dir, bin } = sandbox();
      try {
        const r = run(dir, bin, mgr, args);
        assert.equal(r.status, 0, r.stderr.toString());
        assert.equal(r.stdout.toString().trim(), `NATIVE ${args.join(" ")}`);
        assert.doesNotMatch(r.stderr.toString(), /not supported/);
        assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  // The docker stub fails `docker info`, and with no TTY the wrapper then
  // refuses, so reaching docker at all shows the command took the scan path.
  for (const [mgr, args] of KEPT) {
    test(`${shell}: ${label(mgr, args)} takes the scan path`, {
      skip,
    }, () => {
      const { dir, bin } = sandbox();
      try {
        const r = run(dir, bin, mgr, args);
        const err = r.stderr.toString();
        assert.equal(r.status, 1, err);
        assert.match(err, /Docker not running and no TTY/);
        assert.doesNotMatch(err, /not supported/);
        assert.doesNotMatch(r.stdout.toString(), /NATIVE/);
        assert.equal(fs.existsSync(path.join(dir, "docker.log")), true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  // yarn takes the command from the words before --, so this is a global add.
  test(`${shell}: yarn global -- add x is refused as a global install`, {
    skip,
  }, () => {
    const { dir, bin } = sandbox();
    try {
      const r = run(dir, bin, "yarn", ["global", "--", "add", "x"]);
      assert.equal(r.status, 1, r.stderr.toString());
      assert.match(r.stderr.toString(), /global installs are not supported/);
      assert.doesNotMatch(r.stdout.toString(), /NATIVE/);
      assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("sh: the bypass command keeps each argument's quoting", () => {
  const { dir, bin } = sandbox();
  try {
    const r = runSh(dir, bin, "npm", ["install", "--prefix", "my dir", "a'b"]);
    assert.equal(r.status, 1, r.stderr.toString());
    assert.match(
      r.stderr.toString(),
      /without the safety checks: command npm install --prefix my\\ dir a\\'b\n/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fish: the bypass command keeps each argument's quoting", {
  skip: !fishAvailable,
}, () => {
  const { dir, bin } = sandbox();
  try {
    const r = runFish(dir, bin, "npm", ["install", "--prefix", "my dir"]);
    assert.equal(r.status, 1, r.stderr.toString());
    assert.match(
      r.stderr.toString(),
      /without the safety checks: command npm install --prefix 'my dir'\n/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Before the wrappers looked up _safe_pkg_prescan, an autoloaded fish wrapper
// ran its first command with the global check undefined, so it passed.
test("fish: an autoloaded wrapper refuses a global install on its first run", {
  skip: !fishAvailable,
}, () => {
  const { dir, bin } = sandbox();
  try {
    const r = runFish(dir, bin, "npm", ["install", "-g", "x"]);
    assert.equal(r.status, 1, r.stderr.toString());
    assert.match(r.stderr.toString(), /global installs are not supported/);
    assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A _safe_pkg_prescan.fish from before the directory check: the wrapper must
// refuse rather than treat the unknown function as "no directory flag".
test("fish: a wrapper with an out-of-date _safe_pkg_prescan.fish refuses to install", {
  skip: !fishAvailable,
}, () => {
  const { dir, bin } = sandbox();
  try {
    const fnDir = path.join(dir, "functions");
    fs.mkdirSync(fnDir);
    const stale = fs
      .readFileSync(PRESCAN, "utf8")
      .replace(/\nfunction _safe_pkg_dir_flag [\s\S]*?\nend\n/, "\n");
    assert.doesNotMatch(stale, /function _safe_pkg_dir_flag/);
    fs.writeFileSync(path.join(fnDir, "_safe_pkg_prescan.fish"), stale);
    fs.copyFileSync(
      path.join(ASSETS, "npm-wrapper.fish"),
      path.join(fnDir, "npm.fish"),
    );
    const r = spawnSync(
      "fish",
      [
        "--no-config",
        "-c",
        "set -p fish_function_path $argv[1]; npm -C docs install",
        fnDir,
      ],
      { stdio: "pipe", cwd: dir, env: env(dir, bin) },
    );
    assert.equal(r.status, 1, r.stderr.toString());
    assert.match(r.stderr.toString(), /missing or out of date/);
    assert.doesNotMatch(r.stdout.toString(), /NATIVE/);
    assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fish: a directory check that errors refuses the install", {
  skip: !fishAvailable,
}, () => {
  const { dir, bin } = sandbox();
  try {
    const fnDir = path.join(dir, "functions");
    fs.mkdirSync(fnDir);
    fs.copyFileSync(PRESCAN, path.join(fnDir, "_safe_pkg_prescan.fish"));
    fs.copyFileSync(
      path.join(ASSETS, "pnpm-wrapper.fish"),
      path.join(fnDir, "pnpm.fish"),
    );
    const r = spawnSync(
      "fish",
      [
        "--no-config",
        "-c",
        "set -p fish_function_path $argv[1]; functions -q _safe_pkg_prescan; function _safe_pkg_dir_flag; return 2; end; pnpm install",
        fnDir,
      ],
      { stdio: "pipe", cwd: dir, env: env(dir, bin) },
    );
    assert.equal(r.status, 1, r.stderr.toString());
    assert.match(r.stderr.toString(), /directory-flag check failed \(status 2\)/);
    assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fish: a wrapper without _safe_pkg_prescan.fish refuses to install", {
  skip: !fishAvailable,
}, () => {
  const { dir, bin } = sandbox();
  try {
    const fnDir = path.join(dir, "functions");
    fs.mkdirSync(fnDir);
    fs.copyFileSync(
      path.join(ASSETS, "pnpm-wrapper.fish"),
      path.join(fnDir, "pnpm.fish"),
    );
    const r = spawnSync(
      "fish",
      [
        "--no-config",
        "-c",
        "set -p fish_function_path $argv[1]; pnpm install",
        fnDir,
      ],
      { stdio: "pipe", cwd: dir, env: env(dir, bin) },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr.toString(), /_safe_pkg_prescan\.fish not installed/);
    assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// PowerShell: every case in one Linux pwsh container. Each wrapper call runs
// with $env:CASE set, so a docker call can be traced to the case that made it.
const skipPs1 = hasDocker ? false : "docker not available";
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1dir-"));
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
  const proj = path.join(root, "proj");
  for (const d of [bin, safe, proj]) fs.mkdirSync(d, { recursive: true });
  for (const f of [
    "_safe_pkg_shared.ps1",
    "npm-wrapper.ps1",
    "pnpm-wrapper.ps1",
    "yarn-wrapper.ps1",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    '#!/bin/sh\necho "$CASE $*" >> /w/docker.log\nexit 1\n',
    { mode: 0o755 },
  );
  for (const mgr of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(path.join(bin, mgr), '#!/bin/sh\necho "NATIVE $*"\n', {
      mode: 0o755,
    });
  }
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  const cases = {
    unit: [...REFUSED, ...KEPT].map(([mgr, args], i) => ({
      id: `u${i}`,
      mgr,
      args,
    })),
    run: [...REFUSED, ...PASS_THROUGH].map(([mgr, args], i) => ({
      id: `r${i}`,
      mgr,
      args,
    })),
    kept: KEPT.map(([mgr, args], i) => ({ id: `k${i}`, mgr, args })),
  };
  fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(cases));
  const script = [
    "$env:PATH = '/w/bin:' + $env:PATH",
    '. "$HOME/.safe-pnpm/npm-wrapper.ps1"; . "$HOME/.safe-pnpm/pnpm-wrapper.ps1"; . "$HOME/.safe-pnpm/yarn-wrapper.ps1"',
    "Set-Location /w/proj",
    "$cases = Get-Content /w/cases.json -Raw | ConvertFrom-Json",
    "foreach ($c in $cases.unit) {",
    "  $r = _Safe_Pkg_Dir_Flag -Manager $c.mgr -PassArgs @($c.args)",
    '  "UNIT|$($c.id)|$([bool]$r)"',
    "}",
    "foreach ($c in $cases.run) {",
    "  $env:CASE = $c.id; $global:LASTEXITCODE = 0; $a = @($c.args)",
    "  $out = (& $c.mgr @a *>&1 | Out-String) -replace '\\r?\\n', ' '",
    '  "RUN|$($c.id)|$LASTEXITCODE|$out"',
    "}",
    "foreach ($c in $cases.kept) {",
    "  $env:CASE = $c.id; $global:LASTEXITCODE = 0; $a = @($c.args)",
    "  $out = (& $c.mgr @a *>&1 | Out-String) -replace '\\r?\\n', ' '",
    '  "RUN|$($c.id)|$LASTEXITCODE|$out"',
    "}",
    "function extra($id, [scriptblock]$sb) {",
    "  $env:CASE = $id; $global:LASTEXITCODE = 0",
    "  $out = (& $sb *>&1 | Out-String) -replace '\\r?\\n', ' '",
    '  "EXTRA|$id|$LASTEXITCODE|$out"',
    "}",
    "extra quoted { npm -C 'my dir' install }",
    "extra yarnglobal { yarn global '--' add x }",
    // A wrapper paired with an older _safe_pkg_shared.ps1 that lacks the check.
    "$saved = (Get-Item function:_Safe_Pkg_Dir_Flag).ScriptBlock",
    "Remove-Item function:_Safe_Pkg_Dir_Flag",
    "extra stale { npm -C docs install }",
    "Set-Item function:global:_Safe_Pkg_Dir_Flag -Value $saved",
    // A profile re-run after an update reloads the shared functions, even with
    // the load guard the old _safe_pkg_shared.ps1 set.
    "$global:_SafePkgSharedLoaded = $true",
    "function global:_Safe_Pkg_Dir_Flag { $null }",
    '. "$HOME/.safe-pnpm/npm-wrapper.ps1"',
    "extra reload { npm -C docs install }",
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
  const get = (kind, id) => {
    const line = lines.find((l) => l.startsWith(`${kind}|${id}|`));
    return line ? line.split("|").slice(2) : undefined;
  };
  let dockerLog = "";
  try {
    dockerLog = fs.readFileSync(path.join(root, "docker.log"), "utf8");
  } catch {}
  ps1Result = { cases, get, dockerLog, out: r.stdout + r.stderr };
  return ps1Result;
}

[...REFUSED, ...KEPT].forEach(([mgr, args], i) => {
  const expected = i < REFUSED.length ? "True" : "False";
  test(`ps1: _Safe_Pkg_Dir_Flag ${label(mgr, args)} -> ${expected}`, {
    skip: skipPs1,
  }, () => {
    const { get, out } = runPs1Cases();
    const r = get("UNIT", `u${i}`);
    assert.ok(r, out);
    assert.equal(r[0], expected);
  });
});

[...REFUSED, ...PASS_THROUGH].forEach(([mgr, args], i) => {
  const refused = i < REFUSED.length;
  const what = refused
    ? "is refused before docker is called"
    : `passes through to native ${mgr}`;
  test(`ps1: ${label(mgr, args)} ${what}`, { skip: skipPs1 }, () => {
    const { get, dockerLog, out } = runPs1Cases();
    const r = get("RUN", `r${i}`);
    assert.ok(r, out);
    const [rc, text] = [r[0], r.slice(1).join("|")];
    if (refused) {
      assert.equal(rc, "1", text);
      assert.match(text, /is not supported through the wrapper/);
      assert.match(text, /cd into that directory/);
      assert.match(text, new RegExp(`${mgr}\\.cmd `));
      assert.doesNotMatch(text, /NATIVE/);
    } else {
      assert.equal(rc, "0", text);
      assert.match(text, new RegExp(`NATIVE ${args.join(" ")}`));
      assert.doesNotMatch(text, /not supported/);
    }
    assert.doesNotMatch(dockerLog, new RegExp(`^r${i} `, "m"));
  });
});

KEPT.forEach(([mgr, args], i) => {
  test(`ps1: ${label(mgr, args)} takes the scan path`, { skip: skipPs1 }, () => {
    const { get, dockerLog, out } = runPs1Cases();
    const r = get("RUN", `k${i}`);
    assert.ok(r, out);
    const text = r.slice(1).join("|");
    assert.match(text, /Docker not running and no TTY/);
    assert.doesNotMatch(text, /not supported/);
    assert.doesNotMatch(text, /(^|\s)NATIVE /);
    assert.match(dockerLog, new RegExp(`^k${i} info`, "m"), text);
  });
});

test("ps1: the bypass command keeps each argument's quoting", {
  skip: skipPs1,
}, () => {
  const { get, out } = runPs1Cases();
  const r = get("EXTRA", "quoted");
  assert.ok(r, out);
  const text = r.slice(1).join("|");
  assert.equal(r[0], "1", text);
  assert.match(text, /npm\.cmd -C 'my dir' install/);
});

test("ps1: yarn global -- add x is refused as a global install", {
  skip: skipPs1,
}, () => {
  const { get, dockerLog, out } = runPs1Cases();
  const r = get("EXTRA", "yarnglobal");
  assert.ok(r, out);
  const text = r.slice(1).join("|");
  assert.equal(r[0], "1", text);
  assert.match(text, /global installs are not supported/);
  assert.doesNotMatch(text, /NATIVE/);
  assert.doesNotMatch(dockerLog, /^yarnglobal /m);
});

test("ps1: a wrapper with an out-of-date _safe_pkg_shared.ps1 refuses to install", {
  skip: skipPs1,
}, () => {
  const { get, dockerLog, out } = runPs1Cases();
  const r = get("EXTRA", "stale");
  assert.ok(r, out);
  const text = r.slice(1).join("|");
  assert.equal(r[0], "1", text);
  assert.match(text, /_safe_pkg_shared\.ps1 is missing or out of date/);
  assert.doesNotMatch(text, /NATIVE/);
  assert.doesNotMatch(dockerLog, /^stale /m);
});

test("ps1: dot-sourcing a wrapper again reloads the shared functions", {
  skip: skipPs1,
}, () => {
  const { get, dockerLog, out } = runPs1Cases();
  const r = get("EXTRA", "reload");
  assert.ok(r, out);
  const text = r.slice(1).join("|");
  assert.equal(r[0], "1", text);
  assert.match(text, /is not supported through the wrapper/);
  assert.doesNotMatch(dockerLog, /^reload /m);
});
