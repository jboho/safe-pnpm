const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");
const { ROOTLESS_DOCKER, infoStubSh } = require("./helpers/docker-info-stub");
const {
  berryLock,
  LOCK,
  PHASE1_LOCK,
  enc,
  NPM_TGZ,
  ACME_TGZ,
  SOURCE_LOCKS,
  SAFE_LOCK,
  SAFE_V1_LOCK,
  SAFE_NPM_V1_LOCK,
  GITHUB_BLOCK,
  YARNRC,
  HOME_YARNRC,
  NO_ENV_FILES,
  rc,
  PKG,
  PHASE1_PKG,
  REFUSED,
} = require("./helpers/yarn-berry-fixtures");

// Yarn 2+ (Berry) projects in the PowerShell wrapper: the cases of
// yarn-berry.test.js (bash, zsh) against yarn-wrapper.ps1, plus the ones only
// PowerShell needs (exact arguments, `&&` after a refusal, strict mode, a
// Windows host, a shared file that is out of date). Every case runs in one
// Linux pwsh container, one after the other, with a stub docker; the tests
// below read what each case left behind.
const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";
const t = (name, fn) => test(`ps1: ${name}`, { skip }, fn);

const V1_LOCK =
  '# yarn lockfile v1\n\n\nms@^2.1.3:\n  version "2.1.3"\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#x"\n';
const V1_PKG = { name: "fixture", version: "1.0.0" };
// Folder names a shell splits or reads as a flag.
const MEMBERS = ["a b", "a ", "-x", "new\nline"];
// The wrapper checks that _safe_pkg_shared.ps1 defines these before it reads
// the project.
const GUARDED = [
  "_Safe_Pkg_Is_Global",
  "_Safe_Pkg_Dir_Flag",
  "_Safe_Pkg_Quote_Args",
  "_Safe_Pkg_Yarn_Berry",
  "_Safe_Pkg_Yarn_Berry_Root",
  "_Safe_Pkg_Yarn_Berry_Check",
  "_Safe_Pkg_Yarn_Berry_Run",
];
// Used inside the checks and the sandbox, after that first check.
const INNER = [
  "_Safe_Pkg_Yarn_Berry_Helper",
  "_Safe_Pkg_Yarn_Berry_Audit",
  "_Safe_Pkg_Exec",
];
const NO_NODE_PATH = "/w/bin:/usr/bin:/bin";

// One case is one `yarn <args>` call. Options:
// args        yarn arguments (default ["install"])
// pkg         project package.json object (default PKG)
// yarnrc      project .yarnrc.yml text, or null for none (default YARNRC)
// homeYarnrc  ~/.yarnrc.yml text, or null for none (default HOME_YARNRC)
// lock        project yarn.lock text, or null for none (default LOCK)
// phase1Lock  yarn.lock the fetch writes (default PHASE1_LOCK)
// workspace   root workspaces ["packages/*"] with member packages/a, run from
//             packages/a
// memberPkg   packages/a/package.json text (default a plain manifest)
// members     with workspace, more member folder names under packages/
// cwd         folder under the project to run from; at: a container path
// patches     true, "mixed" or "linked", as in yarn-berry.test.js
// reserved    a package.json in .corepack, .safe-home and .safe-store
// files       extra files in the project root
// env         environment for this case only
// noNode      a PATH without node
// removeFn    remove this function before the call
// hideHelper  move yarn-berry-check.js away for the call
// strict      run under Set-StrictMode -Version Latest
// chain       run `yarn <args> && Write-Output 'NEXT-RAN'`
// win         $env:OS = 'Windows_NT', which the wrappers read as Windows
// mac         the sandbox is told the host is darwin arm64
// rootless    the stub docker answers `docker info` like a rootless daemon
// local       copy the project into the container and make this file
//             unreadable there (a bind mount may ignore the mode)
// auth        registry tokens in the project's .npmrc, .yarnrc and
//             .yarnrc.yml, and a user .npmrc line the sandbox copies
// tmpdir      a folder under /w/tmpdirs to use as TMPDIR for the call
// fakeHelper  the text yarn-berry-check.js prints instead of its answer
const CASES = [];
const add = (id, opts = {}) => {
  CASES.push({ id, ...opts });
};

add("root");
add("noargs", { args: [] });
const HASH_PIN = "yarn@4.18.1+sha512.b2e1e75a0c";
add("hash", { pkg: { ...PKG, packageManager: HASH_PIN } });
const THROUGH = [["add", "ms"], ["up", "ms"], ["dedupe"], ["remove", "ms"]];
for (const [i, args] of THROUGH.entries()) add(`through${i}`, { args });
add("cred", { yarnrc: `${YARNRC}npmAuthToken: "RC-SECRET"\n` });
add("auditwarn", { env: { AUDIT_RC: "1" } });
add("auditstrict", { env: { AUDIT_RC: "1", SAFE_PNPM_STRICT: "1" } });
add("mac", { mac: true });
const OWN_ARCH = `${YARNRC}supportedArchitectures:\n  os: [linux]\n`;
add("macown", { mac: true, yarnrc: OWN_ARCH });
const HOME_AUTH = `${HOME_YARNRC}npmAuthToken: "HOME-SECRET"\n`;
add("homeauth", { homeYarnrc: HOME_AUTH });
add("rootless", {
  homeYarnrc: `${HOME_YARNRC}enableTelemetry: false\n`,
  rootless: true,
});
add("workspace", { workspace: true });
for (const [i, m] of MEMBERS.entries()) {
  add(`mem${i}`, { workspace: true, members: MEMBERS, cwd: `packages/${m}` });
}
add("patches", { patches: true });
add("patchesmixed", { patches: "mixed" });
add("patcheslinked", { patches: "linked" });
add("envauth", {
  yarnrc: `nodeLinker: node-modules\nnpmAuthToken: "\${NPM_TOKEN}"\nnpmScopes:\n  b:\n    npmAuthIdent: "\${B_IDENT}"\n`,
});
add("regmatch", {
  homeYarnrc: `${HOME_YARNRC}npmRegistryServer: "https://npm.acme.example/"\nhttpsProxy: http://proxy.acme.example:3128\nenableStrictSsl: false\n`,
  yarnrc: rc(
    'npmRegistryServer: "https://ci:PASS@NPM.acme.example"\nhttpsProxy: "http://proxy.acme.example:3128" # office\nenableStrictSsl: false\n',
  ),
});
add("regpublic", {
  homeYarnrc: null,
  yarnrc: rc(
    "npmRegistryServer: https://registry.npmjs.org\nenableStrictSsl: true\nnpmScopes:\n  types:\n    npmRegistryServer: https://registry.yarnpkg.com\n",
  ),
});
add("regleak", {
  yarnrc: rc('npmRegistryServer: "https://u:LEAK-PASS@npm.evil.example"\n'),
});
add("depmeta", { pkg: { ...PKG, dependenciesMeta: { ms: { built: false } } } });
add("pinctl", {
  pkg: { ...PKG, packageManager: "yarn@4\u009b2J\u001b]0;x\u0007" },
});
add("nohome", { homeYarnrc: null, yarnrc: rc("") });
add("homenonl", { homeYarnrc: "enableTelemetry: false", yarnrc: rc("") });
const CORP_TGZ = "https://npm.corp.example:8443/c/-/c-1.0.0.tgz";
const PASSING_LOCKS = [
  ["a lockfile with every supported source", { lock: SAFE_LOCK }],
  [
    "downloads from the public registries or ~/.yarnrc.yml",
    {
      lock: berryLock([
        [
          "@acme/x@npm:^1.0.0",
          "1.0.0",
          `@acme/x@npm:1.0.0::__archiveUrl=${enc(ACME_TGZ)}`,
        ],
        [
          "@acme/y@npm:^1.0.0",
          "1.0.0",
          `@acme/y@npm:1.0.0::__archiveUrl=${enc("https://NPM.Acme.Example/y.tgz")}`,
        ],
        [
          "ms@npm:^2.1.3",
          "2.1.3",
          `ms@npm:2.1.3::__archiveUrl=${enc(NPM_TGZ)}`,
        ],
        ["c@npm:^1.0.0", "1.0.0", `c@npm:1.0.0::__archiveUrl=${enc(CORP_TGZ)}`],
        ["d@npm:^1.0.0", "1.0.0+build.1", "d@npm:1.0.0+build.1"],
      ]),
      homeYarnrc: `${HOME_YARNRC}npmRegistryServer: "https://bob:pw@npm.corp.example:8443/" # corp\n`,
    },
  ],
  [
    "a migrated Yarn 1 lockfile from a registry in ~/.yarnrc.yml",
    {
      lock: `# yarn lockfile v1\n\n\n"@acme/x@^1.0.0":\n  version "1.0.0"\n  resolved "${ACME_TGZ}#abc"\n`,
    },
  ],
  ["a migrated Yarn 1 lockfile from a registry", { lock: SAFE_V1_LOCK }],
  [
    "a migrated Yarn 1 lockfile npm wrote from a registry",
    { lock: SAFE_NPM_V1_LOCK },
  ],
  ["nodeLinker: pnpm", { yarnrc: "nodeLinker: pnpm\n" }],
];
for (const [i, [, opts]] of PASSING_LOCKS.entries()) add(`pass${i}`, opts);
add("lockctl", {
  lock: `${LOCK}"ms@x":\n  resolution: "ms@github:x\u001b]0;pwned\u0007"\n`,
});
add("urlcred", {
  yarnrc: `${YARNRC}npmRegistryServer: "https://user:PASS-SECRET@npm.acme.example"\n`,
  homeYarnrc: `${HOME_YARNRC}npmRegistryServer: "https://bob:HOME-PASS@npm.acme.example/"\n`,
});
add("reserved", { reserved: true });
const NATIVE = [
  ["set", "version", "4.18.1"],
  ["version", "check"],
];
for (const [i, args] of NATIVE.entries()) add(`native${i}`, { args });
add("malware", {
  env: { SCAN_RC: "3", SCAN_MSG: "mal-x@1.0.0 is known malware" },
});
for (const [i, [, opts, args]] of REFUSED.entries()) {
  add(`refused${i}`, { ...opts, args });
}
add("y1up", {
  pkg: { ...V1_PKG, scripts: { up: "echo up" } },
  yarnrc: null,
  lock: V1_LOCK,
  args: ["up"],
});

// PowerShell only.
add("exactargs", {
  args: ["add", "x*", "~", "a b", "", "[ab]", "?", "$HOME", "a;b", "'q'"],
  files: ["xa", "xb", "a"],
});
add("chain", { lock: SOURCE_LOCKS[0][1], chain: true });
add("strict", { strict: true, workspace: true });
add("win", { win: true });
GUARDED.forEach((removeFn, i) => {
  add(`guardberry${i}`, { removeFn });
  add(`guardv1${i}`, { removeFn, pkg: V1_PKG, yarnrc: null, lock: V1_LOCK });
});
for (const [i, removeFn] of INNER.entries()) add(`inner${i}`, { removeFn });
add("nohelper", { hideHelper: true });
add("backslash", { workspace: true, members: ["a\\b"] });
add("buildfail", { env: { BUILD_RC: "7" } });
add("fetchfail", { env: { FETCH_RC: "5" } });
add("chainfetchfail", { chain: true, env: { FETCH_RC: "5" } });
add("buildnet", { env: { SAFE_PNPM_BUILD_NETWORK: "1" } });
add("deep", { args: ["--version"], cwd: "src/deep" });
add("deepinstall", { cwd: "src/deep" });
add("fsroot", { args: ["--version"], at: "/" });
add("major0", {
  pkg: { ...V1_PKG, packageManager: "yarn@00004.0.0" },
  yarnrc: null,
  lock: V1_LOCK,
});
add("majorbig", {
  pkg: { ...V1_PKG, packageManager: "yarn@9223372036854775808.0.0" },
  yarnrc: null,
  lock: V1_LOCK,
});
// .NET's ReadAllText decodes a file that starts with a byte order mark as
// UTF-16, which would hide the __metadata: line that grep finds in bash.
add("bomlock", {
  pkg: V1_PKG,
  yarnrc: null,
  lock: Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(LOCK)]),
});
const UNREADABLE = ["yarn.lock", "package.json", "packages/b/package.json"];
for (const [i, local] of UNREADABLE.entries()) {
  add(`unreadable${i}`, { local, workspace: true, members: ["b"] });
}
const AUTH_NPMRC =
  "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=NPMRC-SECRET\n";
const AUTH_YARNRC =
  'registry "https://registry.yarnpkg.com"\n_authToken "YARNRC-SECRET"\n';
const AUTH_YARNRC_YML = `${YARNRC}npmAuthToken: "RC-SECRET"\n`;
const USER_NPMRC = `//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`;
add("auth", { auth: true });
// Characters PowerShell's -Path reads as a wildcard.
const TMPDIRS = ["t*", "t?q", "t[x]"];
for (const [i, tmpdir] of TMPDIRS.entries()) {
  add(`tmpdir${i}`, { auth: true, tmpdir });
}
add("npmrclocked", { auth: true, env: { LOCK_NPMRC: "1" } });
add("stripfail", { env: { BAD_YARNRC: "1" } });
const b64 = (s) => Buffer.from(s).toString("base64");
add("noend", { fakeHelper: `ok\nspec ${b64("yarn@4.18.1")}\n` });
add("badspec", { fakeHelper: `ok\nspec ${b64("yarn@4.18.1 x")}\nend\n` });

const DOCKER_STUB = `#!/bin/sh
if [ -n "$ROOTLESS" ]; then
${infoStubSh(ROOTLESS_DOCKER)}
fi
${infoStubSh()}
[ "$1" = run ] || exit 0
src=""; prev=""
for a in "$@"; do
  case "$prev" in -v) src="\${a%%:/app}" ;; esac
  prev="$a"
done
case " $* " in
  *" npm audit "*) phase=audit ;;
  *" --mode=skip-build "*) phase=fetch ;;
  *" --immutable "*) phase=build ;;
  *) phase=other ;;
esac
d="/w/log/$CASE"
echo "$phase" >> "$d/order"
printf '%s\\n' "$@" > "$d/$phase.argv"
[ -f "$src/.yarnrc.yml" ] && cp "$src/.yarnrc.yml" "$d/$phase.yarnrc"
[ -f "$src/.safe-home/.yarnrc.yml" ] && cp "$src/.safe-home/.yarnrc.yml" "$d/$phase.home"
[ -d "$src/.yarn/patches" ] && ls -A "$src/.yarn/patches" > "$d/$phase.patches"
find "$src/.corepack" "$src/.safe-home" "$src/.safe-store" -name package.json > "$d/$phase.reserved" 2>/dev/null
[ -e "$src/.npmrc" ] && cp "$src/.npmrc" "$d/$phase.npmrc" 2>/dev/null
[ -e "$src/.yarnrc" ] && cp "$src/.yarnrc" "$d/$phase.yarnrc1" 2>/dev/null
[ -e "$src/.safe-home/.npmrc" ] && cp "$src/.safe-home/.npmrc" "$d/$phase.homenpmrc" 2>/dev/null
if [ "$phase" = fetch ]; then
  echo "FETCH-OUT $CASE"
  [ "\${FETCH_RC:-0}" = 0 ] || exit "$FETCH_RC"
  if [ -n "$LOCK_NPMRC" ]; then
    chmod 000 "$src/.npmrc"
    if [ -r "$src/.npmrc" ]; then echo readable; else echo unreadable; fi > "$d/npmrcperm"
  fi
  # A byte the auth strip refuses to rewrite.
  [ -n "$BAD_YARNRC" ] && printf '\\200\\n' >> "$src/.yarnrc.yml"
  mkdir -p "$src/node_modules/ms"
  echo "module.exports=1" > "$src/node_modules/ms/index.js"
  cp "$d/phase1-pkg" "$src/package.json"
  cp "$d/phase1-lock" "$src/yarn.lock"
  if [ -d "$src/packages/a" ]; then
    echo '{"name":"a","version":"1.0.0","dependencies":{"ms":"^2.1.3"}}' > "$src/packages/a/package.json"
  fi
  for m in "$src"/packages/*/; do
    [ -f "$m/package.json" ] || continue
    mkdir -p "$m/node_modules/ms"
    echo "module.exports=1" > "$m/node_modules/ms/index.js"
  done
fi
if [ "$phase" = audit ]; then
  echo "AUDIT-OUT $CASE"
  echo "AUDIT-ERR $CASE" >&2
  exit "\${AUDIT_RC:-0}"
fi
if [ "$phase" = build ]; then
  echo '{"name":"evil"}' > "$src/package.json"
  echo "evil" > "$src/yarn.lock"
  exit "\${BUILD_RC:-0}"
fi
exit 0
`;

const HOST_STUB = (tool) =>
  `#!/bin/sh\necho "${tool} $*" >> "/w/log/$CASE/host"\nexit 0\n`;

// A scanner the case steers: exit 0 "clean" unless SCAN_RC says otherwise.
const SCAN_STUB =
  'console.log(process.env.SCAN_MSG || "clean");\nprocess.exit(Number(process.env.SCAN_RC || 0));\n';

// The whole run. Per case: its ~/.yarnrc.yml goes in place, the call runs
// with every stream captured, and the exit code, the output, $Error and
// whether ~/.yarnrc.yml changed are written to /w/log/<id>/.
const PWSH = `
$env:PATH = '/w/bin:' + $env:PATH
$path0 = $env:PATH
. "$HOME/.safe-pnpm/yarn-wrapper.ps1"
$tmpDir = [IO.Path]::GetTempPath()
$tmp0 = @(Get-ChildItem -LiteralPath $tmpDir -Force | ForEach-Object { $_.Name })
$homeRc = "$HOME/.yarnrc.yml"
$helper = "$HOME/.safe-pnpm/yarn-berry-check.js"
foreach ($c in (Get-Content -LiteralPath /w/cases.json -Raw | ConvertFrom-Json)) {
  $id = $c.id
  $d = "/w/log/$id"
  Remove-Item -LiteralPath $homeRc -Force -ErrorAction Ignore
  if (Test-Path -LiteralPath "$d/homerc") { Copy-Item -LiteralPath "$d/homerc" -Destination $homeRc }
  $rc0 = if (Test-Path -LiteralPath $homeRc) { [IO.File]::ReadAllText($homeRc) } else { '' }
  $env:CASE = $id
  $a = @($c.args)
  $set = @()
  foreach ($p in $c.env.PSObject.Properties) { Set-Item -LiteralPath "env:$($p.Name)" -Value $p.Value; $set += $p.Name }
  if ($c.path) { $env:PATH = $c.path }
  if ($c.win) { $env:OS = 'Windows_NT' }
  $saved = $null
  if ($c.removeFn) { $saved = (Get-Item "function:$($c.removeFn)").ScriptBlock; Remove-Item "function:$($c.removeFn)" }
  $run0 = $null
  if ($c.mac) {
    $run0 = (Get-Item function:_Safe_Pkg_Yarn_Berry_Run).ScriptBlock
    $global:SafePkgTestRun = $run0
    function global:_Safe_Pkg_Yarn_Berry_Run { param($Root, $Spec, $PassArgs) & $global:SafePkgTestRun -Root $Root -Spec $Spec -PassArgs $PassArgs -Os darwin -Cpu arm64 }
  }
  if ($c.hideHelper) { Rename-Item -LiteralPath $helper -NewName hidden.bak }
  if ($c.fakeHelper) { Rename-Item -LiteralPath $helper -NewName hidden.bak; [IO.File]::WriteAllText($helper, $c.fakeHelper) }
  $cwd = $c.cwd
  if ($c.local) {
    $l = "/tmp/local-$id"
    & /bin/cp -R $c.proj $l
    & /bin/chmod 000 "$l/$($c.local)"
    $perm = 'unreadable'
    try { [IO.File]::ReadAllText("$l/$($c.local)") | Out-Null; $perm = 'readable' } catch { }
    [IO.File]::WriteAllText("$d/perm", $perm)
    $cwd = $l
  }
  Set-Location -LiteralPath $cwd
  $global:LASTEXITCODE = 0
  $Error.Clear()
  if ($c.strict) { $out = (& { try { Set-StrictMode -Version Latest; yarn @a } catch { "THROWN: $($_.Exception.Message)" } } *>&1 | Out-String) }
  elseif ($c.chain) { $out = (& { try { yarn @a && Write-Output 'NEXT-RAN' } catch { "THROWN: $($_.Exception.Message)" } } *>&1 | Out-String) }
  else { $out = (& { try { yarn @a } catch { "THROWN: $($_.Exception.Message)" } } *>&1 | Out-String) }
  $rc = $LASTEXITCODE
  $errs = @($Error | ForEach-Object { "$_" }) -join ' ;; '
  Set-Location /
  if ($c.removeFn) { Set-Item "function:global:$($c.removeFn)" -Value $saved }
  if ($run0) { Set-Item function:global:_Safe_Pkg_Yarn_Berry_Run -Value $run0 }
  if ($c.hideHelper) { Rename-Item -LiteralPath "$HOME/.safe-pnpm/hidden.bak" -NewName yarn-berry-check.js }
  if ($c.fakeHelper) { Remove-Item -LiteralPath $helper; Rename-Item -LiteralPath "$HOME/.safe-pnpm/hidden.bak" -NewName yarn-berry-check.js }
  foreach ($n in $set) { Remove-Item -LiteralPath "env:$n" }
  if ($c.win) { Remove-Item env:OS }
  $env:PATH = $path0
  if ($c.local) { & /bin/chmod -R u+rwX "/tmp/local-$id"; Remove-Item -LiteralPath "/tmp/local-$id" -Recurse -Force }
  $rc1 = if (Test-Path -LiteralPath $homeRc) { [IO.File]::ReadAllText($homeRc) } else { '' }
  [IO.File]::WriteAllText("$d/homesame", "$([string]::Equals($rc0, $rc1, [StringComparison]::Ordinal))")
  [IO.File]::WriteAllText("$d/out", $out)
  [IO.File]::WriteAllText("$d/errors", $errs)
  [IO.File]::WriteAllText("$d/rc", "$rc")
}
$tmp1 = @(Get-ChildItem -LiteralPath $tmpDir -Force | ForEach-Object { $_.Name })
[IO.File]::WriteAllText('/w/log/tmp-left', (@($tmp1 | Where-Object { $tmp0 -notcontains $_ }) -join ','))
`;

function writeCase(root, c) {
  const proj = path.join(root, "home", c.id, "proj");
  const log = path.join(root, "log", c.id);
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(log, { recursive: true });
  const ws = c.workspace ? { workspaces: ["packages/*"] } : {};
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ ...(c.pkg ?? PKG), ...ws }),
  );
  const yarnrc = c.yarnrc === undefined ? YARNRC : c.yarnrc;
  if (yarnrc !== null) fs.writeFileSync(path.join(proj, ".yarnrc.yml"), yarnrc);
  const lock = c.lock === undefined ? LOCK : c.lock;
  if (lock !== null) fs.writeFileSync(path.join(proj, "yarn.lock"), lock);
  const homeYarnrc = c.homeYarnrc === undefined ? HOME_YARNRC : c.homeYarnrc;
  if (homeYarnrc !== null)
    fs.writeFileSync(path.join(log, "homerc"), homeYarnrc);
  if (c.patches) {
    const outside = path.join(root, "home", c.id);
    const yarnDir =
      c.patches === "linked"
        ? path.join(outside, "outside-yarn")
        : path.join(proj, ".yarn");
    fs.mkdirSync(path.join(yarnDir, "patches"), { recursive: true });
    fs.writeFileSync(
      path.join(yarnDir, "patches", "ms.patch"),
      "--- a/index.js\n",
    );
    // Relative targets, so the links resolve inside the container too.
    if (c.patches === "linked")
      fs.symlinkSync("../outside-yarn", path.join(proj, ".yarn"));
    if (c.patches === "mixed") {
      fs.writeFileSync(path.join(yarnDir, "patches", "notes.txt"), "x\n");
      fs.writeFileSync(path.join(outside, "outside.patch"), "--- a/x\n");
      fs.symlinkSync(
        "../../../outside.patch",
        path.join(yarnDir, "patches", "link.patch"),
      );
    }
  }
  if (c.reserved) {
    for (const d of [
      ".corepack/v1/yarn/4.18.1",
      ".safe-home",
      ".safe-store/x",
    ]) {
      fs.mkdirSync(path.join(proj, d), { recursive: true });
      fs.writeFileSync(path.join(proj, d, "package.json"), "{}");
    }
  }
  for (const f of c.files ?? []) fs.writeFileSync(path.join(proj, f), "x");
  const env = { ...c.env };
  if (c.rootless) env.ROOTLESS = "1";
  if (c.auth) {
    fs.writeFileSync(path.join(proj, ".npmrc"), AUTH_NPMRC);
    fs.writeFileSync(path.join(proj, ".yarnrc"), AUTH_YARNRC);
    fs.writeFileSync(path.join(proj, ".yarnrc.yml"), AUTH_YARNRC_YML);
    const user = path.join(root, "home", c.id, "user.npmrc");
    fs.writeFileSync(user, USER_NPMRC);
    env.NPM_CONFIG_USERCONFIG = `/w/home/${c.id}/user.npmrc`;
  }
  if (c.tmpdir) {
    fs.mkdirSync(path.join(root, "tmpdirs", c.tmpdir), { recursive: true });
    env.TMPDIR = `/w/tmpdirs/${c.tmpdir}/`;
  }
  let cwd = proj;
  if (c.workspace) {
    cwd = path.join(proj, "packages", "a");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      c.memberPkg ?? JSON.stringify({ name: "a", version: "1.0.0" }),
    );
    for (const [i, m] of (c.members ?? []).entries()) {
      fs.mkdirSync(path.join(proj, "packages", m));
      fs.writeFileSync(
        path.join(proj, "packages", m, "package.json"),
        JSON.stringify({ name: `m${i}`, version: "1.0.0" }),
      );
    }
  }
  if (c.cwd) {
    cwd = path.join(proj, c.cwd);
    fs.mkdirSync(cwd, { recursive: true });
  }
  fs.writeFileSync(path.join(log, "phase1-lock"), c.phase1Lock ?? PHASE1_LOCK);
  fs.writeFileSync(
    path.join(log, "phase1-pkg"),
    JSON.stringify({ ...PHASE1_PKG, ...ws }),
  );
  const inW = (p) => `/w/${path.relative(root, p).split(path.sep).join("/")}`;
  return {
    id: c.id,
    cwd: c.at ?? inW(cwd),
    proj: inW(proj),
    args: c.args ?? ["install"],
    env,
    path: c.noNode ? NO_NODE_PATH : "",
    removeFn: c.removeFn ?? "",
    hideHelper: !!c.hideHelper,
    fakeHelper: c.fakeHelper
      ? `process.stdout.write(${JSON.stringify(c.fakeHelper)});\n`
      : "",
    strict: !!c.strict,
    chain: !!c.chain,
    win: !!c.win,
    mac: !!c.mac,
    local: c.local ?? "",
  };
}

let root;
let container;
before(() => {
  if (!hasDocker) return;
  buildPwshImage();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1b-"));
  const safe = path.join(root, "home", ".safe-pnpm");
  const bin = path.join(root, "bin");
  for (const d of [safe, bin]) fs.mkdirSync(d, { recursive: true });
  for (const f of [
    "_safe_pkg_shared.ps1",
    "yarn-wrapper.ps1",
    "yarn-berry-check.js",
    "link-check.js",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  fs.writeFileSync(path.join(safe, "malware-scan.js"), SCAN_STUB);
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  for (const tool of ["yarn", "corepack"]) {
    fs.writeFileSync(path.join(bin, tool), HOST_STUB(tool), { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(root, "cases.json"),
    JSON.stringify(CASES.map((c) => writeCase(root, c))),
  );
  container = spawnSync(
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
      "-e",
      "NPM_TOKEN=SECRET-TOKEN-VALUE",
      "-v",
      `${root}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-Command",
      PWSH,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
});
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// What the case `id` left behind.
function ran(id) {
  const d = path.join(root, "log", id);
  const has = (f) => fs.existsSync(path.join(d, f));
  const read = (f) => fs.readFileSync(path.join(d, f), "utf8");
  assert.ok(
    has("rc"),
    `case ${id} did not finish (container exit ${container.status}): ${container.stderr.slice(-2000)}`,
  );
  const lines = (f) => (has(f) ? read(f).trim().split("\n") : []);
  return {
    proj: path.join(root, "home", id, "proj"),
    status: Number(read("rc")),
    out: read("out"),
    errors: read("errors"),
    order: lines("order"),
    host: lines("host"),
    argv: (phase) => read(`${phase}.argv`).replace(/\n$/, "").split("\n"),
    read,
    has,
  };
}
const ALL = ["fetch", "audit", "build"];
const passes = (id) => {
  const r = ran(id);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.order, ALL, r.out);
  return r;
};
// No container, no native Yarn, exit 1, and the thrown refusal.
const refused = (id, reason) => {
  const r = ran(id);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, reason);
  assert.match(r.out, /THROWN: safe-pnpm: command refused/);
  assert.deepEqual(r.order, [], r.out);
  assert.deepEqual(r.host, [], r.out);
  return r;
};
const rawControls = (s, top) =>
  [...s].filter((ch) => {
    const n = ch.charCodeAt(0);
    return n < 9 || (n > 10 && n < 32 && n !== 13) || (n >= 127 && n < top);
  });

const U = `${process.getuid()}:${process.getgid()}`;
const HEAD = [
  "run",
  "--rm",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "1024",
  "--user",
  U,
  "-e",
  "HOME=/app/.safe-home",
];
const BERRY_ENV = [
  "-e",
  "COREPACK_HOME=/app/.corepack",
  "-e",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
  "-e",
  "YARN_IGNORE_PATH=1",
  "-e",
  "YARN_CACHE_FOLDER=/app/.safe-store",
  "-e",
  "YARN_ENABLE_GLOBAL_CACHE=0",
  "-e",
  "YARN_ENABLE_TELEMETRY=0",
];
const NO_SCRIPTS = ["-e", "YARN_ENABLE_SCRIPTS=0", "-e", NO_ENV_FILES];
const TOKEN = ["-e", "NPM_TOKEN"];
const mountOf = (argv) => argv[argv.indexOf("-v") + 1];

t("the pwsh container ran every case", () => {
  assert.equal(container.status, 0, container.stderr.slice(-2000));
  for (const c of CASES) ran(c.id);
});

t("install runs fetch, audit and build containers in that order", () => {
  const r = passes("root");
  assert.deepEqual(r.host, []);
  assert.equal(r.errors, "", "a passing run leaves $Error empty");
});

t(
  "phase 1 runs the pinned Yarn through corepack with --mode=skip-build",
  () => {
    const a = ran("root").argv("fetch");
    assert.match(mountOf(a), /^\/tmp\/[^:]+:\/app$/);
    assert.deepEqual(a, [
      ...HEAD,
      "-v",
      mountOf(a),
      "-w",
      "/app",
      ...TOKEN,
      ...BERRY_ENV,
      ...NO_SCRIPTS,
      "safe-pnpm:latest",
      "corepack",
      "yarn@4.18.1",
      "install",
      "--mode=skip-build",
    ]);
    assert.ok(!a.includes("SECRET-TOKEN-VALUE"));
  },
);

t("the containers' own output reaches the terminal", () => {
  assert.match(container.stdout, /^FETCH-OUT root$/m);
});

t("bare yarn runs an install", () => {
  const r = passes("noargs");
  assert.deepEqual(r.argv("fetch").slice(-3), [
    "yarn@4.18.1",
    "install",
    "--mode=skip-build",
  ]);
});

t("the pin's hash reaches corepack, which checks the download with it", () => {
  const r = passes("hash");
  for (const phase of ALL) {
    const a = r.argv(phase);
    assert.equal(a[a.indexOf("corepack") + 1], HASH_PIN, phase);
  }
});

THROUGH.forEach((args, i) => {
  t(`yarn ${args.join(" ")} goes through the sandbox`, () => {
    const r = passes(`through${i}`);
    assert.deepEqual(r.argv("fetch").slice(-(args.length + 2)), [
      "yarn@4.18.1",
      ...args,
      "--mode=skip-build",
    ]);
    assert.deepEqual(r.host, []);
  });
});

t(
  "the audit runs in a container with network, before the auth is stripped",
  () => {
    const a = ran("root").argv("audit");
    assert.deepEqual(a, [
      ...HEAD,
      ...TOKEN,
      ...BERRY_ENV,
      ...NO_SCRIPTS,
      "-v",
      mountOf(a),
      "-w",
      "/app",
      "safe-pnpm:latest",
      "corepack",
      "yarn@4.18.1",
      "npm",
      "audit",
      "--all",
      "--recursive",
      "--severity",
      "moderate",
    ]);
    assert.match(passes("cred").read("audit.yarnrc"), /RC-SECRET/);
  },
);

t(
  "a failed audit prints the audit's output and continues without a terminal",
  () => {
    const r = passes("auditwarn");
    assert.match(
      r.out,
      /yarn audit failed or found issues — continuing in non-interactive mode/,
    );
    assert.match(container.stderr, /^AUDIT-OUT auditwarn$/m);
    assert.match(container.stderr, /^AUDIT-ERR auditwarn$/m);
    assert.doesNotMatch(
      container.stderr,
      /AUDIT-OUT root/,
      "a passing audit prints nothing",
    );
  },
);

t("a failed audit blocks the build under SAFE_PNPM_STRICT=1", () => {
  const r = ran("auditstrict");
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.order, ["fetch", "audit"]);
  assert.match(
    r.out,
    /yarn audit failed or found issues\. Blocking \(SAFE_PNPM_STRICT=1\)/,
  );
  assert.ok(!fs.existsSync(path.join(r.proj, "node_modules")));
  assert.equal(fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"), LOCK);
});

t(
  "phase 2 installs --immutable offline, without the token or auth lines",
  () => {
    const a = ran("root").argv("build");
    assert.deepEqual(a, [
      ...HEAD,
      "--network",
      "none",
      "-v",
      mountOf(a),
      "-w",
      "/app",
      ...BERRY_ENV,
      "-e",
      "YARN_ENABLE_NETWORK=0",
      "-e",
      "COREPACK_ENABLE_NETWORK=0",
      "safe-pnpm:latest",
      "corepack",
      "yarn@4.18.1",
      "install",
      "--immutable",
    ]);
    const cred = ran("cred");
    assert.match(cred.read("fetch.yarnrc"), /RC-SECRET/);
    assert.doesNotMatch(cred.read("build.yarnrc"), /RC-SECRET|npmAuthToken/);
  },
);

t(
  "SAFE_PNPM_BUILD_NETWORK=1 opens the build's network but keeps Yarn offline and the token out",
  () => {
    const a = passes("buildnet").argv("build");
    assert.ok(!a.includes("--network"));
    assert.ok(a.includes("YARN_ENABLE_NETWORK=0"));
    assert.ok(!a.includes("NPM_TOKEN"));
  },
);

t(
  "copy-back brings node_modules, package.json and yarn.lock, and leaves .yarnrc.yml alone",
  () => {
    const { proj } = passes("root");
    assert.ok(fs.existsSync(path.join(proj, "node_modules", "ms", "index.js")));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(proj, "package.json"), "utf8")),
      PHASE1_PKG,
      "package.json is the one the fetch wrote, not the build's",
    );
    assert.equal(
      fs.readFileSync(path.join(proj, "yarn.lock"), "utf8"),
      PHASE1_LOCK,
    );
    assert.equal(
      fs.readFileSync(path.join(proj, ".yarnrc.yml"), "utf8"),
      YARNRC,
    );
    assert.deepEqual(fs.readdirSync(proj).sort(), [
      ".yarnrc.yml",
      "node_modules",
      "package.json",
      "yarn.lock",
    ]);
  },
);

t(
  "on a macOS host the sandbox .yarnrc.yml also asks for darwin arm64 builds",
  () => {
    const r = passes("mac");
    for (const phase of ["fetch", "build"]) {
      assert.match(
        r.read(`${phase}.yarnrc`),
        /^supportedArchitectures:\n {2}os:\n {4}- current\n {4}- darwin\n {2}cpu:\n {4}- current\n {4}- arm64\n/m,
        phase,
      );
    }
    assert.equal(
      fs.readFileSync(path.join(r.proj, ".yarnrc.yml"), "utf8"),
      YARNRC,
    );
    assert.doesNotMatch(
      ran("root").read("fetch.yarnrc"),
      /supportedArchitectures/,
    );
  },
);

t(
  "on a macOS host a project's own supportedArchitectures is left as it is",
  () => {
    assert.equal(passes("macown").read("fetch.yarnrc"), OWN_ARCH);
  },
);

t("~/.yarnrc.yml reaches the fetch, and phase 2 gets it without auth", () => {
  const r = passes("homeauth");
  assert.equal(r.read("fetch.home"), HOME_AUTH + GITHUB_BLOCK);
  assert.equal(r.read("audit.home"), HOME_AUTH + GITHUB_BLOCK);
  assert.doesNotMatch(r.read("build.home"), /HOME-SECRET|npmAuthToken/);
  assert.match(
    r.read("build.home"),
    /npmRegistryServer: "https:\/\/npm\.acme\.example"/,
  );
});

t(
  "under rootless Docker the containers still read the sandbox ~/.yarnrc.yml",
  () => {
    const r = passes("rootless");
    for (const phase of ALL) {
      const a = r.argv(phase);
      assert.ok(!a.includes("--user"), phase);
      assert.equal(
        a.filter((x) => x === "HOME=/app/.safe-home").length,
        1,
        phase,
      );
    }
  },
);

t("on Windows the containers get HOME once and no --user", () => {
  const r = passes("win");
  for (const phase of ALL) {
    const a = r.argv(phase);
    assert.ok(!a.includes("--user"), phase);
    assert.equal(
      a.filter((x) => x === "HOME=/app/.safe-home").length,
      1,
      phase,
    );
  }
});

t(
  "from a workspace member, the install runs at the root and member manifests come back",
  () => {
    const r = passes("workspace");
    for (const phase of ALL) {
      const a = r.argv(phase);
      assert.equal(a[a.indexOf("-w") + 1], "/app/packages/a", phase);
    }
    assert.equal(
      fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"),
      PHASE1_LOCK,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(r.proj, "packages", "a", "package.json"),
          "utf8",
        ),
      ),
      { name: "a", version: "1.0.0", dependencies: { ms: "^2.1.3" } },
    );
    assert.ok(!fs.existsSync(path.join(r.proj, "packages", "a", "yarn.lock")));
  },
);

MEMBERS.forEach((m, i) => {
  t(
    `a member folder named ${JSON.stringify(m)} is the working folder and gets its files back`,
    () => {
      const r = passes(`mem${i}`);
      for (const phase of ALL) {
        assert.ok(
          r.read(`${phase}.argv`).includes(`\n-w\n/app/packages/${m}\n`),
          `${phase}: ${r.read(`${phase}.argv`)}`,
        );
      }
      const packages = path.join(r.proj, "packages");
      assert.deepEqual(
        fs.readdirSync(packages).sort(),
        ["a", ...MEMBERS].sort(),
        "no half of a split or trimmed folder name is created",
      );
      for (const name of ["a", ...MEMBERS]) {
        const dir = path.join(packages, name);
        assert.ok(
          fs.existsSync(path.join(dir, "node_modules", "ms", "index.js")),
          JSON.stringify(name),
        );
        assert.ok(
          fs.existsSync(path.join(dir, "package.json")),
          JSON.stringify(name),
        );
      }
      assert.deepEqual(fs.readdirSync(r.proj).sort(), [
        ".yarnrc.yml",
        "node_modules",
        "package.json",
        "packages",
        "yarn.lock",
      ]);
    },
  );
});

t(".yarn/patches reaches the sandbox, so patch: dependencies resolve", () => {
  assert.equal(passes("patches").read("fetch.patches").trim(), "ms.patch");
});

t("only regular .patch files from .yarn/patches reach the sandbox", () => {
  assert.equal(passes("patchesmixed").read("fetch.patches").trim(), "ms.patch");
});

t("no patches reach the sandbox when .yarn is a symlink", () => {
  assert.equal(passes("patcheslinked").has("fetch.patches"), false);
});

t("an environment variable in npmAuthToken or npmAuthIdent still runs", () => {
  passes("envauth");
});

t("registry and proxy settings that match ~/.yarnrc.yml still run", () => {
  passes("regmatch");
});

t("the public npm registry and enableStrictSsl: true still run", () => {
  passes("regpublic");
});

t("a refused registry is shown without its URL password", () => {
  const r = refused(
    "regleak",
    /sets npmRegistryServer to https:\/\/npm\.evil\.example,/,
  );
  assert.doesNotMatch(r.out, /LEAK-PASS/);
});

t("dependenciesMeta built: false still runs", () => {
  passes("depmeta");
});

t("a packageManager pin with control characters is not echoed raw", () => {
  const r = refused("pinctl", /not an exact Yarn version/);
  assert.deepEqual(rawControls(r.out, 160), [], r.out);
});

t("the fetch's ~/.yarnrc.yml blocks GitHub when there is none", () => {
  assert.equal(passes("nohome").read("fetch.home"), GITHUB_BLOCK);
});

t(
  "the GitHub block goes on its own line after a ~/.yarnrc.yml with no final newline",
  () => {
    assert.equal(
      passes("homenonl").read("fetch.home"),
      `enableTelemetry: false\n${GITHUB_BLOCK}`,
    );
  },
);

t("no case changes the real ~/.yarnrc.yml", () => {
  for (const c of CASES) {
    assert.equal(ran(c.id).read("homesame"), "True", c.id);
  }
});

PASSING_LOCKS.forEach(([name], i) => {
  t(`${name} passes the check`, () => {
    passes(`pass${i}`);
  });
});

t("control characters from yarn.lock never reach the terminal raw", () => {
  const r = ran("lockctl");
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.order, []);
  assert.deepEqual(rawControls(r.out, 128), [], r.out);
});

t("URL credentials in .yarnrc.yml files stay out of phase 2", () => {
  const r = passes("urlcred");
  assert.match(r.read("fetch.yarnrc"), /PASS-SECRET/);
  const b = r.read("build.yarnrc");
  assert.doesNotMatch(b, /PASS-SECRET|user:/);
  assert.match(b, /npmRegistryServer: "https:\/\/npm\.acme\.example"/);
  const h = r.read("build.home");
  assert.doesNotMatch(h, /HOME-PASS|bob:/);
  assert.match(h, /npmRegistryServer: "https:\/\/npm\.acme\.example\/"/);
});

t("package.json files in the sandbox's own folders are not copied in", () => {
  assert.equal(passes("reserved").read("fetch.reserved"), "");
});

NATIVE.forEach((args, i) => {
  t(`yarn ${args.join(" ")} still runs natively`, () => {
    const r = ran(`native${i}`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.host, [`yarn ${args.join(" ")}`]);
  });
});

t("a malware verdict on the resolved yarn.lock blocks the build", () => {
  const r = ran("malware");
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.order, ["fetch"], r.out);
  assert.match(r.out, /mal-x@1\.0\.0/);
  assert.match(r.out, /install blocked/);
  assert.equal(fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"), LOCK);
  assert.ok(!fs.existsSync(path.join(r.proj, "node_modules")));
});

REFUSED.forEach(([name, , args, reason], i) => {
  t(`${name} is refused before any container runs`, () => {
    const r = refused(`refused${i}`, reason);
    assert.ok(
      r.out.includes(
        `To run it without the safety checks: yarn.cmd ${args.join(" ")}\n`,
      ),
      r.out,
    );
  });
});

t(
  "in a Yarn 1 project, yarn up still runs the project's own script natively",
  () => {
    const r = ran("y1up");
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.host, ["yarn up"]);
  },
);

// PowerShell only.

t(
  "arguments reach Yarn exactly: no glob, tilde or variable expansion, spaces and empty ones kept",
  () => {
    const r = passes("exactargs");
    assert.deepEqual(r.argv("fetch").slice(-12), [
      "yarn@4.18.1",
      "add",
      "x*",
      "~",
      "a b",
      "",
      "[ab]",
      "?",
      "$HOME",
      "a;b",
      "'q'",
      "--mode=skip-build",
    ]);
  },
);

t(
  "a refusal is a terminating error, so `yarn install && next` does not run next",
  () => {
    const r = refused(
      "chain",
      /resolves a dependency from a source the wrapper does not support/,
    );
    assert.doesNotMatch(r.out, /NEXT-RAN/);
    assert.match(
      r.out,
      /To run it without the safety checks: yarn\.cmd install\n/,
    );
  },
);

// As README.md says: a sandbox step that fails sets $LASTEXITCODE only.
t(
  "a failed fetch is no terminating error, so `yarn install && next` runs next",
  () => {
    const r = ran("chainfetchfail");
    assert.equal(r.status, 5, r.out);
    assert.deepEqual(r.order, ["fetch"], r.out);
    assert.match(r.out, /NEXT-RAN/);
    assert.doesNotMatch(r.out, /THROWN/);
  },
);

t("the sandbox runs under Set-StrictMode -Version Latest", () => {
  const r = passes("strict");
  assert.equal(r.errors, "");
  assert.ok(
    fs.existsSync(
      path.join(r.proj, "packages", "a", "node_modules", "ms", "index.js"),
    ),
  );
});

GUARDED.forEach((fn, i) => {
  for (const [kind, id] of [
    ["Yarn 2+", `guardberry${i}`],
    ["Yarn 1", `guardv1${i}`],
  ]) {
    t(
      `a _safe_pkg_shared.ps1 without ${fn} refuses a ${kind} project instead of skipping the check`,
      () => {
        const r = ran(id);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /_safe_pkg_shared\.ps1 is missing or out of date/);
        assert.match(r.out, /THROWN: safe-pnpm: command refused/);
        assert.deepEqual(r.order, [], r.out);
        assert.deepEqual(r.host, [], r.out);
      },
    );
  }
});

INNER.forEach((fn, i) => {
  t(`a _safe_pkg_shared.ps1 without ${fn} never builds or copies back`, () => {
    const r = ran(`inner${i}`);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /THROWN: safe-pnpm: command refused/);
    assert.ok(!r.order.includes("build"), r.order.join());
    assert.deepEqual(r.host, []);
    assert.ok(!fs.existsSync(path.join(r.proj, "node_modules")));
    assert.equal(fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"), LOCK);
  });
});

t("a missing yarn-berry-check.js refuses and names safe-pnpm update", () => {
  refused(
    "nohelper",
    /the Yarn 2\+ checks are not installed \(.*yarn-berry-check\.js is missing\); run safe-pnpm update\./,
  );
});

t(
  "a member folder with a backslash in its name is refused before any container runs",
  () => {
    const r = ran("backslash");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /has a backslash in its name/);
    assert.deepEqual(r.order, []);
    assert.ok(
      !fs.existsSync(path.join(r.proj, "a")),
      "no folder from a split name",
    );
  },
);

UNREADABLE.forEach((file, i) => {
  t(`an unreadable ${file} is refused before any container runs`, () => {
    const r = ran(`unreadable${i}`);
    assert.equal(
      r.read("perm"),
      "unreadable",
      "the fixture must be unreadable in the container",
    );
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /THROWN: safe-pnpm: command refused/);
    assert.deepEqual(r.order, [], r.out);
    assert.deepEqual(r.host, [], r.out);
  });
});

t(
  "a failed build still copies back, and its exit code is the command's",
  () => {
    const r = ran("buildfail");
    assert.equal(r.status, 7, r.out);
    assert.deepEqual(r.order, ALL);
    assert.ok(
      fs.existsSync(path.join(r.proj, "node_modules", "ms", "index.js")),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(r.proj, "package.json"), "utf8")),
      PHASE1_PKG,
    );
    assert.equal(
      fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"),
      PHASE1_LOCK,
    );
  },
);

t(
  "a failed fetch copies nothing back, and its exit code is the command's",
  () => {
    const r = ran("fetchfail");
    assert.equal(r.status, 5, r.out);
    assert.deepEqual(r.order, ["fetch"]);
    assert.ok(!fs.existsSync(path.join(r.proj, "node_modules")));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(r.proj, "package.json"), "utf8")),
      PKG,
    );
    assert.equal(fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"), LOCK);
  },
);

t(
  "from a folder below the root, the root is found and the folder is the working folder",
  () => {
    const r = passes("deepinstall");
    for (const phase of ALL) {
      const a = r.argv(phase);
      assert.equal(a[a.indexOf("-w") + 1], "/app/src/deep", phase);
    }
    assert.ok(
      fs.existsSync(path.join(r.proj, "node_modules", "ms", "index.js")),
    );
    assert.ok(!fs.existsSync(path.join(r.proj, "src", "deep", "node_modules")));
    assert.deepEqual(ran("deep").host, ["yarn --version"]);
  },
);

t("the walk up to the root stops at the filesystem root", () => {
  const r = ran("fsroot");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.host, ["yarn --version"]);
});

t(
  "yarn@00004.0.0 is not an exact Yarn 2+ pin, so the project stays Yarn 1, as in bash",
  () => {
    const r = ran("major0");
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.order, ["other", "other"], r.out);
    assert.doesNotMatch(r.read("other.argv"), /corepack/);
  },
);

t("a major version too large for an integer is Yarn 2+, not Yarn 1", () => {
  refused("majorbig", /installs with Plug'n'Play/);
});

t(
  "a yarn.lock that starts with a UTF-16 byte order mark is read as bytes, as in bash",
  () => {
    refused("bomlock", /does not pin a Yarn version with packageManager/);
  },
);

// The auth fixture's tokens reach the fetch, and none of them the build.
const authStripped = (r) => {
  assert.match(r.read("fetch.npmrc"), /NPMRC-SECRET/);
  assert.match(r.read("fetch.yarnrc1"), /YARNRC-SECRET/);
  assert.match(r.read("fetch.yarnrc"), /RC-SECRET/);
  assert.match(r.read("fetch.homenpmrc"), /:_authToken=\$\{NPM_TOKEN\}/);
  assert.equal(r.read("build.npmrc"), "registry=https://registry.npmjs.org/\n");
  assert.equal(
    r.read("build.yarnrc1"),
    'registry "https://registry.yarnpkg.com"\n',
  );
  assert.doesNotMatch(r.read("build.yarnrc"), /RC-SECRET|npmAuthToken/);
  assert.equal(r.has("build.homenpmrc"), false, "the user .npmrc copy");
};

t(
  "the build sees no token in .npmrc, .yarnrc, .yarnrc.yml or the sandbox user .npmrc",
  () => {
    const r = passes("auth");
    assert.ok(
      r.argv("fetch").includes("NPM_CONFIG_USERCONFIG=/app/.safe-home/.npmrc"),
    );
    authStripped(r);
  },
);

TMPDIRS.forEach((dir, i) => {
  t(
    `with TMPDIR ${dir} the run works, the auth is stripped and no temp file is left`,
    () => {
      const r = passes(`tmpdir${i}`);
      assert.ok(
        mountOf(r.argv("build")).startsWith(`/w/tmpdirs/${dir}/`),
        mountOf(r.argv("build")),
      );
      authStripped(r);
      assert.ok(
        fs.existsSync(path.join(r.proj, "node_modules", "ms", "index.js")),
      );
      assert.deepEqual(fs.readdirSync(path.join(root, "tmpdirs", dir)), []);
    },
  );
});

// The run stopped after the audit: nothing built, nothing copied back.
const stoppedBeforeBuild = (id, reason) => {
  const r = ran(id);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.order, ["fetch", "audit"], r.out);
  assert.match(r.out, reason);
  assert.ok(!fs.existsSync(path.join(r.proj, "node_modules")));
  assert.equal(fs.readFileSync(path.join(r.proj, "yarn.lock"), "utf8"), LOCK);
  return r;
};

t("a .npmrc the auth strip cannot read stops the run before the build", () => {
  const r = stoppedBeforeBuild(
    "npmrclocked",
    /could not remove the registry credentials from \S*\.npmrc; the build phase did not run\./,
  );
  assert.equal(
    r.read("npmrcperm"),
    "unreadable\n",
    "the fixture must be unreadable in the container",
  );
  assert.match(r.out, /THROWN: safe-pnpm: command refused/);
});

t("a .yarnrc.yml the auth strip refuses stops the run before the build", () => {
  stoppedBeforeBuild(
    "stripfail",
    /could not remove the registry credentials from \S*\.yarnrc\.yml; the build phase did not run\./,
  );
});

t("a helper answer without its closing end line is refused", () => {
  refused("noend", /gave no answer the wrapper can read/);
});

t("the pin the helper answers with is checked again before it runs", () => {
  refused("badspec", /returned no exact Yarn pin/);
});

t("no sandbox folder is left in the temp folder", () => {
  assert.equal(fs.readFileSync(path.join(root, "log", "tmp-left"), "utf8"), "");
});
