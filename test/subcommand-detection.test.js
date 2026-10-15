const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { SCANNED, NATIVE } = require("./helpers/wrapper-cases");

const ASSETS = path.join(__dirname, "..", "assets");

// Stub the two exits so nothing installs: the scan path prints "scanned" and
// the pass-through path prints "NATIVE".
const bashProbe = (cmd) =>
  spawnSync(
    "bash",
    [
      "-c",
      `_SAFE_PKG_SHARED_LOADED=1
command() { echo NATIVE; }
source "$1/_safe_pkg_shared.sh"; source "$1/pnpm-wrapper.sh"; source "$1/npm-wrapper.sh"; source "$1/yarn-wrapper.sh"
_safe_pkg_dispatch() { echo scanned; }
${cmd}`,
      "bash",
      ASSETS,
    ],
    { encoding: "utf8" },
  );

for (const cmd of SCANNED) {
  test(`sh wrapper scans: ${cmd}`, () => {
    assert.equal(bashProbe(cmd).stdout.trim(), "scanned");
  });
}
for (const cmd of NATIVE) {
  test(`sh wrapper passes through: ${cmd}`, () => {
    assert.equal(bashProbe(cmd).stdout.trim(), "NATIVE");
  });
}

const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

// The finder asks _safe_pkg_dir_flag about one flag at a time, so that call
// reaches the real function; the refusals, which see every argument, are
// stubbed out like _safe_pkg_dispatch in the sh probe. The -- refusal is
// inline in each wrapper, after the finder, so reaching it also shows the
// command took the scan path.
const fishProbe = (cmd) =>
  spawnSync(
    "fish",
    [
      "-c",
      `source ${ASSETS}/_safe_pkg_prescan.fish
functions -c _safe_pkg_dir_flag _real_dir_flag
function _safe_pkg_dir_flag; test (count $argv) -eq 2; and _real_dir_flag $argv; or return 1; end
function _safe_pkg_is_global; return 1; end
function _safe_pkg_prescan; echo scanned; return 1; end
function npm; end; function yarn; end; function pnpm; end
source ${ASSETS}/pnpm-wrapper.fish; source ${ASSETS}/npm-wrapper.fish; source ${ASSETS}/yarn-wrapper.fish
${cmd}`,
    ],
    { encoding: "utf8" },
  );

for (const cmd of SCANNED) {
  test(`fish wrapper scans: ${cmd}`, { skip: !fishAvailable }, () => {
    const r = fishProbe(cmd);
    if (cmd.split(" ").includes("--")) {
      assert.match(r.stderr, /-- is not supported through the wrapper/);
    } else {
      assert.equal(r.stdout.trim(), "scanned");
    }
  });
}
test("zsh and bash agree on every probe", {
  skip: spawnSync("zsh", ["-c", "true"]).status !== 0,
}, () => {
  for (const cmd of [...SCANNED, ...NATIVE]) {
    const script = `_SAFE_PKG_SHARED_LOADED=1
command() { echo NATIVE; }
source "$1/_safe_pkg_shared.sh"; source "$1/pnpm-wrapper.sh"; source "$1/npm-wrapper.sh"; source "$1/yarn-wrapper.sh"
_safe_pkg_dispatch() { echo scanned; }
${cmd}`;
    const z = spawnSync("zsh", ["-c", script, "zsh", ASSETS], {
      encoding: "utf8",
    });
    assert.equal(z.stdout.trim(), bashProbe(cmd).stdout.trim(), cmd);
  }
});

// The three shell families keep their own copy of each manager's lists; fail
// if they drift apart.
const fs = require("node:fs");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
for (const m of ["pnpm", "npm", "yarn"]) {
  test(`${m} command lists match across sh, fish and ps1`, () => {
    const sh = read("_safe_pkg_shared.sh");
    const shBlock = sh.match(new RegExp(`    ${m}\\)\\n([\\s\\S]*?)\\) ;;`))[1];
    // The value-flag lists live in _safe_pkg_valueflags, shared with the
    // runner finder; the install and native lists are in _safe_pkg_subcmd.
    const shFlags = sh.match(
      new RegExp(`\\n    ${m}(?:\\|npx)?\\) printf '%s' "([^"]*)"`),
    )[1];
    const shList = (k) =>
      k === "valueflags"
        ? shFlags.split(" ")
        : shBlock.match(new RegExp(`${k}=" ([^"]*) "`))[1].split(" ");
    const fish = read(`${m}-wrapper.fish`);
    // fish keeps its value-flag lists in _safe_pkg_valueflags too.
    const fishFlags = read("_safe_pkg_prescan.fish").match(
      new RegExp(
        `\\n        case ${m}(?: npx)?\\n            printf '%s\\\\n' ([^\\n]*)`,
      ),
    )[1];
    const fishList = (k) =>
      k === "value_flags"
        ? fishFlags.split(" ")
        : fish.match(new RegExp(`set -l ${k} ([^\\n]*)`))[1].split(" ");
    const ps = read(`${m}-wrapper.ps1`);
    const psList = (k) =>
      [
        ...ps
          .match(new RegExp(`\\$${k} = @\\(([^)]*)\\)`))[1]
          .matchAll(/'([^']*)'/g),
      ].map((x) => x[1]);
    for (const [k, fk, pk] of [
      ["install", "install_cmds", "installCmds"],
      ["native", "native_cmds", "nativeCmds"],
      ["valueflags", "value_flags", "valueFlags"],
    ]) {
      assert.deepEqual(fishList(fk), shList(k), `${m} fish ${k}`);
      assert.deepEqual(psList(pk), shList(k), `${m} ps1 ${k}`);
    }
  });
}
