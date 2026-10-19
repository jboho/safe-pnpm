// _Safe_Pkg_Run_Native and _Safe_Pkg_Cmd_Line from _safe_pkg_shared.ps1, in a
// Linux pwsh container. A .cmd launcher runs through $env:SystemRoot's
// System32/cmd.exe, so an sh stub there stands in for cmd.exe: it logs its
// argv, prints two lines, copies stdin when asked and exits 5. On Linux pwsh
// splits the --% text into argv where Windows hands it over as one command
// line, so the quoting itself is checked against spawnCommand here and run
// for real by windows-cmd-shims.test.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");
const { spawnCommand } = require("../lib/util/shims");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";
const ARGS = ['q"q', "a&b", "a|b", "%PATH%", "^", "", "a b", "back\\"];

let tmp;
before(() => {
  if (skip) return;
  buildPwshImage();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1native-"));
  fs.copyFileSync(
    path.join(ASSETS, "_safe_pkg_shared.ps1"),
    path.join(tmp, "_safe_pkg_shared.ps1"),
  );
  fs.mkdirSync(path.join(tmp, "root", "System32"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "root", "System32", "cmd.exe"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > /w/cmdargs',
      'echo "OUT one"',
      'echo "OUT two"',
      '[ -n "$READ_STDIN" ] && cat',
      "exit 5",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(tmp, "npm.cmd"), "");
  fs.writeFileSync(path.join(tmp, "args.json"), JSON.stringify(ARGS));
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function pwsh(script, input) {
  fs.writeFileSync(path.join(tmp, "t.ps1"), script);
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--platform",
      "linux/amd64",
      "-v",
      `${tmp}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-File",
      "/w/t.ps1",
    ],
    { encoding: "utf8", input: input ?? "" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const PRELUDE = `. /w/_safe_pkg_shared.ps1
$env:SystemRoot = '/w/root'
`;

test("a .cmd launcher's output can be captured, piped and redirected", {
  skip,
}, () => {
  const out = pwsh(`${PRELUDE}
$env:_SAFE_PKG_CMDLINE = 'prev'
$v = _Safe_Pkg_Run_Native '/w/npm.cmd' @('-v')
"captured=$($v -join '|') rc=$LASTEXITCODE"
_Safe_Pkg_Run_Native '/w/npm.cmd' @('x') | ForEach-Object { "piped:$_" }
_Safe_Pkg_Run_Native '/w/npm.cmd' @('x') > /w/redir.txt
"redirected rc=$LASTEXITCODE"
"restored=$env:_SAFE_PKG_CMDLINE"
`);
  assert.match(out, /^captured=OUT one\|OUT two rc=5$/m);
  assert.match(out, /^piped:OUT one\npiped:OUT two$/m);
  assert.match(out, /^redirected rc=5$/m);
  assert.match(out, /^restored=prev$/m);
  assert.doesNotMatch(out, /^OUT /m);
  assert.equal(
    fs.readFileSync(path.join(tmp, "redir.txt"), "utf8"),
    "OUT one\nOUT two\n",
  );
  // cmd.exe got /d /s /c and the expanded line, not the variable's name.
  const argv = fs.readFileSync(path.join(tmp, "cmdargs"), "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(argv.slice(3).join(" "), /\/w\/npm\.cmd/);
  assert.doesNotMatch(argv.join(" "), /_SAFE_PKG_CMDLINE/);
});

test("a caller's Standard argument passing does not reach the .cmd call", {
  skip,
}, () => {
  // Under Standard, PowerShell splits the --% text on spaces and re-quotes
  // it, so cmd.exe would get a broken line. Under Legacy the line is parsed
  // as one Windows command line, which keeps "/w/npm.cmd ..." in one piece.
  // On Linux pwsh then splits that line by the Windows argument rules, where
  // each ^" in it flips quoting; on Windows cmd.exe gets it whole. Both
  // callers must hand cmd.exe exactly these pieces of the line
  // /w/npm.cmd ^^^"a^^^ b^^^" ^^^"q\^^^"q^^^" ^^^"a^^^&b^^^"
  const want = [
    "/d",
    "/s",
    "/c",
    "/w/npm.cmd ^^^a^^^",
    "b^^^ ^^^q\\^^^q^^^",
    '^^^a^^^&b^^^"',
    "",
  ];
  const out = pwsh(`${PRELUDE}
$PSNativeCommandArgumentPassing = 'Legacy'
$null = _Safe_Pkg_Run_Native '/w/npm.cmd' @('a b', 'q"q', 'a&b')
Copy-Item /w/cmdargs /w/cmdargs.legacy
$PSNativeCommandArgumentPassing = 'Standard'
$v = _Safe_Pkg_Run_Native '/w/npm.cmd' @('a b', 'q"q', 'a&b')
"captured=$($v -join '|') rc=$LASTEXITCODE"
"caller=$PSNativeCommandArgumentPassing"
`);
  assert.match(out, /^captured=OUT one\|OUT two rc=5$/m);
  assert.match(out, /^caller=Standard$/m);
  const read = (f) => fs.readFileSync(path.join(tmp, f), "utf8").split("\n");
  assert.deepEqual(read("cmdargs.legacy"), want);
  assert.deepEqual(read("cmdargs"), want);
});

test("stdin passes through to a .cmd launcher", { skip }, () => {
  const out = pwsh(
    `${PRELUDE}
$env:READ_STDIN = '1'
_Safe_Pkg_Run_Native '/w/npm.cmd' @()
"rc=$LASTEXITCODE"
`,
    "from stdin\n",
  );
  assert.match(out, /^OUT two\nfrom stdin\nrc=5$/m);
});

test("_Safe_Pkg_Cmd_Line builds the same line as spawnCommand", {
  skip,
}, () => {
  const out = pwsh(`${PRELUDE}
$a = Get-Content -Raw /w/args.json | ConvertFrom-Json -NoEnumerate
[Console]::Out.Write((_Safe_Pkg_Cmd_Line 'C:\\x\\pnpm.cmd' $a))
`);
  const want = spawnCommand(["C:\\x\\pnpm.cmd", ...ARGS], {}, "win32").args[3];
  assert.equal(out, want.slice(1, -1));
});
