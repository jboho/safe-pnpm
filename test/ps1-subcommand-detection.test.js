const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");
const {
  SCANNED,
  NATIVE,
  GLOBAL,
  LOCAL,
  WRAPPER_CASES,
} = require("./helpers/wrapper-cases");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";

// PowerShell turns an unquoted number into an Int32, which has no ToLower();
// these walk past one as the value of an unknown flag.
const PS_ONLY_SCANNED = [
  "pnpm --some-future-flag 4 add x",
  "npm --some-future-flag 3 i",
];

const psList = (args) => `@(${args.map((a) => `'${a}'`).join(",")})`;

// Each case is a line of PowerShell plus a label. The wrapper functions run as
// they would from a profile; `_Safe_Pkg_Prescan` is replaced so the scan path
// logs "scanned" and stops, and stub npm/pnpm/yarn binaries on PATH log
// "NATIVE <manager> <args>" for the pass-through path. A stub docker logs
// "DOCKER" so a refusal can be shown to come before any container.
const CASES = [];
const add = (label, line) => CASES.push({ label, line });
for (const cmd of [...SCANNED, ...PS_ONLY_SCANNED, ...NATIVE]) add(cmd, cmd);
for (const args of GLOBAL) {
  const line =
    args[0] === "global"
      ? `yarn ${args.join(" ")}`
      : `npm install ${args.join(" ")}`;
  add(line, line);
  add(
    `is_global ${args.join(" ")}`,
    `"GLOBAL=$(_Safe_Pkg_Is_Global -PassArgs ${psList(args)})"`,
  );
}
for (const args of LOCAL) {
  // Splatted, so a `--` reaches the wrapper (see the typed case below).
  add(`npm install @${psList(args)}`, `$a = ${psList(args)}; npm install @a`);
  add(
    `is_global ${args.join(" ")}`,
    `"GLOBAL=$(_Safe_Pkg_Is_Global -PassArgs ${psList(args)})"`,
  );
}
for (const [mgr, args] of WRAPPER_CASES) {
  const line = `${mgr} ${args.join(" ")}`;
  if (!CASES.some((c) => c.label === line)) add(line, line);
}
add("typed npm install -- -g", "npm install -- -g");
add("npm run build '--' --watch", "npm run build '--' --watch");
add("npm run exit7", "npm run exit7");

let tmp;
const results = new Map();
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1sub-"));
  if (!hasDocker) return;
  buildPwshImage();
  const bin = path.join(tmp, "bin");
  const safe = path.join(tmp, "home", ".safe-pnpm");
  const outDir = path.join(tmp, "out");
  for (const d of [bin, safe, outDir, path.join(tmp, "proj")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of [
    "_safe_pkg_shared.ps1",
    "npm-wrapper.ps1",
    "pnpm-wrapper.ps1",
    "yarn-wrapper.ps1",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  for (const m of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(
      path.join(bin, m),
      `#!/bin/sh\necho "NATIVE ${m} $*" >> /w/log\ncase "$*" in *exit7*) exit 7 ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    '#!/bin/sh\necho "DOCKER $*" >> /w/log\nexit 0\n',
    {
      mode: 0o755,
    },
  );
  const script = [
    "$env:PATH = '/w/bin:' + $env:PATH",
    ...["npm", "pnpm", "yarn"].map(
      (m) => `. "$HOME/.safe-pnpm/${m}-wrapper.ps1"`,
    ),
    "function global:_Safe_Pkg_Prescan { Add-Content /w/log 'scanned'; return $false }",
    "Set-Location /w/proj",
    ...CASES.flatMap(({ line }, i) => [
      `$global:LASTEXITCODE = 0; $Error.Clear(); Add-Content /w/log 'CASE ${i}'`,
      `$o = & { ${line} } *>&1 | Out-String`,
      `Set-Content /w/out/${i}.txt $o`,
      `Add-Content /w/log "RC=$LASTEXITCODE ERRORS=$($Error.Count)"`,
    ]),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(tmp, "t.ps1"), script);
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
      `${tmp}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-File",
      "/w/t.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = fs.readFileSync(path.join(tmp, "log"), "utf8");
  for (const block of log.split(/^CASE /m).slice(1)) {
    const [idx, ...lines] = block.trimEnd().split("\n");
    const out = fs.readFileSync(path.join(outDir, `${idx}.txt`), "utf8");
    results.set(Number(idx), { lines, out });
  }
  assert.equal(results.size, CASES.length, "every case ran");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const result = (label) => {
  const i = CASES.findIndex((c) => c.label === label);
  const r = results.get(i);
  assert.ok(r, `no result for ${label}`);
  const status = r.lines.at(-1);
  return { events: r.lines.slice(0, -1), status, out: r.out };
};

const NO_ERRORS = /ERRORS=0$/;

// The sh probe stubs the whole install path, refusals included. The ps1
// wrappers refuse a global install, a directory flag and a -- after the finder
// has picked an install subcommand and before the scan, so reaching one of
// those refusals also shows the command took the scan path.
const REFUSAL =
  /global installs are not supported|is not supported through the wrapper/;
const assertScanPath = (r) => {
  if (r.events.length === 0 && REFUSAL.test(r.out)) {
    assert.equal(r.status, "RC=1 ERRORS=0", r.out);
    return;
  }
  assert.deepEqual(r.events, ["scanned"], r.out);
  assert.match(r.status, NO_ERRORS, r.out);
};

for (const cmd of [...SCANNED, ...PS_ONLY_SCANNED]) {
  test(`ps1 wrapper scans: ${cmd}`, { skip }, () => {
    assertScanPath(result(cmd));
  });
}

for (const cmd of NATIVE) {
  test(`ps1 wrapper passes through: ${cmd}`, { skip }, () => {
    const r = result(cmd);
    assert.deepEqual(
      r.events.map((e) => e.trimEnd()),
      [`NATIVE ${cmd}`],
      r.out,
    );
    assert.equal(r.status, "RC=0 ERRORS=0", r.out);
  });
}

test("ps1 pass-through keeps a quoted -- and the native exit code", {
  skip,
}, () => {
  const quoted = result("npm run build '--' --watch");
  assert.deepEqual(quoted.events, ["NATIVE npm run build -- --watch"]);
  const failed = result("npm run exit7");
  assert.deepEqual(failed.events, ["NATIVE npm run exit7"]);
  assert.equal(failed.status, "RC=7 ERRORS=0");
});

for (const args of GLOBAL) {
  const line =
    args[0] === "global"
      ? `yarn ${args.join(" ")}`
      : `npm install ${args.join(" ")}`;
  test(`ps1: ${line} is refused with exit 1 before any scan or docker call`, {
    skip,
  }, () => {
    const r = result(line);
    assert.deepEqual(r.events, [], r.out);
    assert.equal(r.status, "RC=1 ERRORS=0", r.out);
    assert.match(r.out, /global installs are not supported/);
    const mgr = line.split(" ")[0];
    assert.ok(
      r.out.includes(`run: ${mgr}.cmd ${line.slice(mgr.length + 1)}`),
      r.out,
    );
  });
}

for (const [list, expected] of [
  [GLOBAL, "True"],
  [LOCAL, "False"],
]) {
  for (const args of list) {
    test(`ps1: _Safe_Pkg_Is_Global "${args.join(" ")}" -> ${expected}`, {
      skip,
    }, () => {
      const r = result(`is_global ${args.join(" ")}`);
      assert.equal(r.out.trim(), `GLOBAL=${expected}`);
    });
  }
}

for (const args of LOCAL) {
  test(`ps1: npm install ${args.join(" ")} is not refused as global`, {
    skip,
  }, () => {
    const r = result(`npm install @${psList(args)}`);
    assert.doesNotMatch(r.out, /global installs are not supported/);
    assertScanPath(r);
  });
}

for (const [mgr, args] of WRAPPER_CASES) {
  const line = `${mgr} ${args.join(" ")}`;
  test(`ps1: ${line} is refused before docker is called`, { skip }, () => {
    const r = result(line);
    assert.deepEqual(r.events, [], r.out);
    assert.equal(r.status, "RC=1 ERRORS=0", r.out);
    assert.match(r.out, /global installs are not supported/);
  });
}

// PowerShell removes an unquoted `--` before a function sees its arguments, so
// the wrapper cannot tell `npm install -- -g` from `npm install -g`. It refuses
// both, which errs on the safe side.
test("ps1: a typed -- never reaches the wrapper, so install -- -g is refused", {
  skip,
}, () => {
  const r = result("typed npm install -- -g");
  assert.deepEqual(r.events, [], r.out);
  assert.equal(r.status, "RC=1 ERRORS=0", r.out);
});
