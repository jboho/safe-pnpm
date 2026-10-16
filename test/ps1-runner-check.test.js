const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");
const { RUNNERS, OTHERS } = require("./helpers/runner-cases");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";

const psList = (args) => `@(${args.map((a) => `'${a}'`).join(",")})`;

// One pwsh container runs every case. The OSV stub runs inside it (it listens
// on the container's loopback), with the real scanner, the three wrappers
// dot-sourced as from a profile, and stub npm, npx, pnpm and yarn binaries on
// PATH. The stub npm answers `npm view` the way runner-check.test.js's does;
// every stub logs its call to /w/log.
const CASES = [];
const add = (label, line, env = {}) => CASES.push({ label, line, env });
for (const [manager, args] of [...RUNNERS, ...OTHERS]) {
  add(
    `specs ${manager} ${args.join(" ")}`,
    `(_Safe_Pkg_Runner_Specs -Manager ${manager} -PassArgs ${psList(args)}) -join "\`n"`,
  );
}
const DEAD = { SAFE_PNPM_OSV_API: "http://127.0.0.1:1" };
add("npx cowsay hi", "npx cowsay hi");
add("npx mal-pkg", "npx mal-pkg");
add("npx -p mal-pkg cowsay", "npx -p mal-pkg cowsay");
add("pnpm dlx mal-pkg", "pnpm dlx mal-pkg");
add("yarn dlx mal-pkg", "yarn dlx mal-pkg");
add("pnpm dlx cowsay", "pnpm dlx cowsay");
add("pnpm create vite app", "pnpm create vite app");
add("npm exec mal-pkg", "npm exec mal-pkg");
add("npm exec cowsay", "npm exec cowsay");
add("yarn create react-app app", "yarn create react-app app");
add("npx unknown-pkg", "npx unknown-pkg");
add("npx ./local-tool", "npx ./local-tool");
add("unreachable", "npx cowsay", DEAD);
add("unreachable strict", "npx cowsay", { ...DEAD, SAFE_PNPM_OSV_STRICT: "1" });
add("malformed", "pnpm dlx cowsay", { SAFE_PNPM_OSV_API: "$osv/badjson" });
add("malformed strict", "pnpm dlx cowsay", {
  SAFE_PNPM_OSV_API: "$osv/badjson",
  SAFE_PNPM_STRICT: "1",
});
add("broken-pkg", "npx broken-pkg");
add("broken-pkg strict", "npx broken-pkg", { SAFE_PNPM_OSV_STRICT: "1" });
add("npm run build", "npm run build");
// Windows PowerShell, and pwsh for .cmd targets, drop "" before the native
// command sees it; Legacy does the same here.
const legacy = (line) => `$PSNativeCommandArgumentPassing = 'Legacy'; ${line}`;
add("empty positional legacy", legacy('npx "" mal-pkg'));
add("empty -p legacy", legacy('npx -p "" mal-pkg'));
add("empty before exec legacy", legacy('npm "" exec mal-pkg'));
add("empty positional standard", 'npx "" mal-pkg');
add("NPX mal-pkg", "NPX mal-pkg");
add("npm EXEC mal-pkg", "npm EXEC mal-pkg");
add("npm init mal", "npm init mal");
// Unquoted, PowerShell reads @scope as splatting $scope.
add("npm create @scope", "npm create '@scope'");
add("exact version", "npx mal-pkg@1.2.3");
const noScanner = (line) =>
  `Move-Item $HOME/.safe-pnpm/malware-scan.js /w/scan.bak; try { ${line} } finally { Move-Item /w/scan.bak $HOME/.safe-pnpm/malware-scan.js }`;
add("no scanner", noScanner("npx cowsay"));
add("no scanner strict", noScanner("npx cowsay"), {
  SAFE_PNPM_OSV_STRICT: "1",
});
// node lives in /usr/local/bin in the image; the stubs only need /bin/sh.
const noNode = (line) =>
  `$p = $env:PATH; $env:PATH = '/w/bin:/usr/bin:/bin'; try { ${line} } finally { $env:PATH = $p }`;
add("no node", noNode("npx mal-pkg"));
add("no node strict", noNode("npx mal-pkg"), { SAFE_PNPM_OSV_STRICT: "1" });

let tmp;
const results = new Map();
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1run-"));
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
    "malware-scan.js",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  fs.copyFileSync(
    path.join(__dirname, "helpers", "osv-stub.js"),
    path.join(tmp, "osv-stub.js"),
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh
echo "npm $*" >> /w/log
if [ "$1" = view ]; then
  case "$2" in
    unknown-*) echo "npm error code E404" >&2; exit 1 ;;
    broken-*) echo "npm error code ECONNRESET" >&2; exit 1 ;;
    *) echo '"1.2.3"'; exit 0 ;;
  esac
fi
`,
    { mode: 0o755 },
  );
  for (const name of ["npx", "pnpm", "yarn"]) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "RAN ${name} $*" >> /w/log\n`,
      { mode: 0o755 },
    );
  }
  // Values are PowerShell double-quoted strings, so "$osv" is the stub's URL.
  const setEnv = (env) =>
    [
      "Remove-Item Env:SAFE_PNPM_OSV_STRICT, Env:SAFE_PNPM_STRICT -ErrorAction SilentlyContinue",
      ...Object.entries({ SAFE_PNPM_OSV_API: "$osv/ok", ...env }).map(([k, v]) => `$env:${k} = "${v}"`),
    ].join("; ");
  const script = [
    "$env:PATH = '/w/bin:' + $env:PATH",
    "$stub = Start-Process node -ArgumentList '/w/osv-stub.js' -RedirectStandardOutput /w/port -PassThru",
    "$t = 0; while ($t -lt 100 -and -not ((Test-Path /w/port) -and (Get-Content /w/port))) { Start-Sleep -Milliseconds 100; $t++ }",
    '$osv = "http://127.0.0.1:$(@(Get-Content /w/port)[0].Trim())"',
    ...["npm", "pnpm", "yarn"].map(
      (m) => `. "$HOME/.safe-pnpm/${m}-wrapper.ps1"`,
    ),
    "Set-Location /w/proj",
    ...CASES.flatMap(({ line, env }, i) => [
      setEnv(env),
      `$global:LASTEXITCODE = 0; $Error.Clear(); Add-Content /w/log 'CASE ${i}'`,
      `$o = & { ${line} } *>&1 | Out-String`,
      `Set-Content /w/out/${i}.txt $o`,
      `Add-Content /w/log "RC=$LASTEXITCODE ERRORS=$($Error.Count)"`,
    ]),
    "Stop-Process $stub",
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
    results.set(Number(idx), {
      calls: lines.slice(0, -1).join("\n"),
      status: lines.at(-1),
      out,
    });
  }
  assert.equal(results.size, CASES.length, "every case ran");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const result = (label) => {
  const r = results.get(CASES.findIndex((c) => c.label === label));
  assert.ok(r, `no result for ${label}`);
  return r;
};

test("ps1: _Safe_Pkg_Runner_Specs finds the packages a runner command fetches", {
  skip,
}, () => {
  for (const [manager, args, want] of RUNNERS) {
    const label = `specs ${manager} ${args.join(" ")}`;
    const r = result(label);
    assert.deepEqual(r.out.split("\n").filter(Boolean), want, label);
    assert.equal(r.status, "RC=0 ERRORS=0", label);
  }
});

test("ps1: _Safe_Pkg_Runner_Specs finds nothing for commands that fetch nothing to run", {
  skip,
}, () => {
  for (const [manager, args] of OTHERS) {
    const label = `specs ${manager} ${args.join(" ")}`;
    const r = result(label);
    assert.equal(r.out.trim(), "", label);
    assert.equal(r.status, "RC=0 ERRORS=0", label);
  }
});

test("ps1: npx of a clean package checks it, then runs it", { skip }, () => {
  const r = result("npx cowsay hi");
  assert.equal(r.status, "RC=0 ERRORS=0", r.out);
  assert.match(r.out, /1 package checked against OSV; none known malicious/);
  assert.match(r.calls, /npm view cowsay version --json/);
  assert.match(r.calls, /RAN npx cowsay hi/);
});

test("ps1: npx of a known-malicious package is blocked and never runs", {
  skip,
}, () => {
  const r = result("npx mal-pkg");
  assert.equal(r.status, "RC=1 ERRORS=0", r.out);
  assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.match(
    r.out,
    /✗ safe-pnpm: not running it; no package code was executed\./,
  );
  assert.doesNotMatch(r.calls, /RAN/);
});

test("ps1: a malicious package passed with -p is blocked even when the command word is clean", {
  skip,
}, () => {
  const r = result("npx -p mal-pkg cowsay");
  assert.equal(r.status, "RC=1 ERRORS=0", r.out);
  assert.doesNotMatch(r.calls, /RAN/);
});

test("ps1: pnpm dlx, yarn dlx and npm exec are checked before they run", {
  skip,
}, () => {
  for (const label of [
    "pnpm dlx mal-pkg",
    "yarn dlx mal-pkg",
    "npm exec mal-pkg",
  ]) {
    const r = result(label);
    assert.equal(r.status, "RC=1 ERRORS=0", `${label}\n${r.out}`);
    assert.doesNotMatch(r.calls, /RAN|npm exec/, label);
  }
  const ok = result("pnpm dlx cowsay");
  assert.equal(ok.status, "RC=0 ERRORS=0", ok.out);
  assert.match(ok.calls, /RAN pnpm dlx cowsay/);
  const exec = result("npm exec cowsay");
  assert.equal(exec.status, "RC=0 ERRORS=0", exec.out);
  assert.match(exec.calls, /^npm exec cowsay$/m);
});

test("ps1: create commands check the create- package the manager would fetch", {
  skip,
}, () => {
  const p = result("pnpm create vite app");
  assert.equal(p.status, "RC=0 ERRORS=0", p.out);
  assert.match(p.calls, /npm view create-vite version --json/);
  assert.match(p.calls, /RAN pnpm create vite app/);
  const y = result("yarn create react-app app");
  assert.equal(y.status, "RC=0 ERRORS=0", y.out);
  assert.match(y.calls, /npm view create-react-app version --json/);
  assert.match(y.calls, /RAN yarn create react-app app/);
});

test("ps1: a package the registry does not have is noted and the command still runs", {
  skip,
}, () => {
  const r = result("npx unknown-pkg");
  assert.equal(r.status, "RC=0 ERRORS=0", r.out);
  assert.match(r.out, /0 packages checked.*1 not checked/);
  assert.match(r.calls, /RAN npx unknown-pkg/);
});

test("ps1: a local path is not sent to npm view or OSV", { skip }, () => {
  const r = result("npx ./local-tool");
  assert.equal(r.status, "RC=0 ERRORS=0", r.out);
  assert.doesNotMatch(r.calls, /npm view/);
  assert.match(r.calls, /RAN npx \.\/local-tool/);
});

test("ps1: an unreachable OSV warns and runs; SAFE_PNPM_OSV_STRICT=1 blocks", {
  skip,
}, () => {
  const warn = result("unreachable");
  assert.equal(warn.status, "RC=0 ERRORS=0", warn.out);
  assert.match(warn.out, /could not reach OSV.*Continuing without it/s);
  assert.match(warn.calls, /RAN npx cowsay/);
  const strict = result("unreachable strict");
  assert.equal(strict.status, "RC=1 ERRORS=0", strict.out);
  assert.match(
    strict.out,
    /could not reach OSV.*Blocking \(SAFE_PNPM_OSV_STRICT=1\)/s,
  );
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("ps1: a malformed OSV answer warns and runs; SAFE_PNPM_STRICT=1 blocks", {
  skip,
}, () => {
  const warn = result("malformed");
  assert.equal(warn.status, "RC=0 ERRORS=0", warn.out);
  assert.match(warn.out, /Malware scan could not run.*Continuing without it/s);
  assert.match(warn.calls, /RAN pnpm dlx cowsay/);
  const strict = result("malformed strict");
  assert.equal(strict.status, "RC=1 ERRORS=0", strict.out);
  assert.match(strict.out, /Blocking \(SAFE_PNPM_STRICT=1\)/);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("ps1: a failed version lookup counts as a scan failure, not a pass", {
  skip,
}, () => {
  const warn = result("broken-pkg");
  assert.equal(warn.status, "RC=0 ERRORS=0", warn.out);
  assert.match(warn.out, /could not look up broken-pkg/);
  const strict = result("broken-pkg strict");
  assert.equal(strict.status, "RC=1 ERRORS=0", strict.out);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("ps1: commands that run no downloaded package skip the check", {
  skip,
}, () => {
  const r = result("npm run build");
  assert.equal(r.status, "RC=0 ERRORS=0", r.out);
  assert.doesNotMatch(r.calls, /npm view/);
  assert.doesNotMatch(r.out, /Malware scan/);
});

test("ps1: an empty argument does not hide the package from the check", {
  skip,
}, () => {
  for (const label of [
    "empty positional legacy",
    "empty -p legacy",
    "empty before exec legacy",
    "empty positional standard",
  ]) {
    const r = result(label);
    assert.match(r.status, /^RC=1 /, `${label}\n${r.out}`);
    assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/, label);
    assert.doesNotMatch(r.calls, /RAN|npm exec/, label);
  }
});

test("ps1: wrapper names and subcommands are matched in any case", {
  skip,
}, () => {
  for (const label of ["NPX mal-pkg", "npm EXEC mal-pkg"]) {
    const r = result(label);
    assert.equal(r.status, "RC=1 ERRORS=0", `${label}\n${r.out}`);
    assert.doesNotMatch(r.calls, /RAN|npm EXEC/, label);
  }
});

test("ps1: npm init and npm create check the create- package first", {
  skip,
}, () => {
  const init = result("npm init mal");
  assert.equal(init.status, "RC=0 ERRORS=0", init.out);
  assert.match(init.calls, /npm view create-mal version --json\nnpm init mal$/);
  const create = result("npm create @scope");
  assert.equal(create.status, "RC=0 ERRORS=0", create.out);
  assert.match(
    create.calls,
    /npm view @scope\/create version --json\nnpm create @scope$/,
  );
});

test("ps1: an exact version is checked without npm view", { skip }, () => {
  const r = result("exact version");
  assert.equal(r.status, "RC=1 ERRORS=0", r.out);
  assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.doesNotMatch(r.calls, /npm view|RAN/);
});

test("ps1: a missing scanner warns and runs; SAFE_PNPM_OSV_STRICT=1 blocks", {
  skip,
}, () => {
  const warn = result("no scanner");
  assert.match(warn.status, /^RC=0 /, warn.out);
  assert.match(warn.out, /Malware scan not installed.*Continuing without it/s);
  assert.match(warn.calls, /RAN npx cowsay/);
  const strict = result("no scanner strict");
  assert.match(strict.status, /^RC=1 /, strict.out);
  assert.match(
    strict.out,
    /not installed.*Blocking \(SAFE_PNPM_OSV_STRICT=1\)/s,
  );
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("ps1: a missing node is a scan failure, not a pass", { skip }, () => {
  const warn = result("no node");
  assert.match(warn.status, /^RC=0 /, warn.out);
  assert.match(warn.out, /node not found.*Continuing without it/s);
  assert.doesNotMatch(warn.out, /✓/);
  assert.match(warn.calls, /RAN npx mal-pkg/);
  const strict = result("no node strict");
  assert.match(strict.status, /^RC=1 /, strict.out);
  assert.match(
    strict.out,
    /node not found.*Blocking \(SAFE_PNPM_OSV_STRICT=1\)/s,
  );
  assert.doesNotMatch(strict.calls, /RAN/);
});
