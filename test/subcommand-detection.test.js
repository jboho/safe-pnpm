const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");

const SCANNED = [
  "pnpm install",
  "pnpm i",
  "pnpm up",
  "pnpm upgrade",
  "pnpm it",
  "pnpm rm x",
  "pnpm un x",
  "pnpm uninstall x",
  "pnpm --filter app add x",
  "pnpm -C web install",
  "pnpm -r install",
  "npm ci",
  "npm add lodash",
  "npm clean-install",
  "npm cit",
  "npm rm x",
  "npm --prefix web ci",
  "npm --workspace a install x",
  "yarn add x",
  "yarn",
  "yarn --cwd web add x",
  "yarn upgrade-interactive",
  // aliases and abbreviations reported in review
  "pnpm ic",
  "pnpm clean-install",
  "pnpm uni x",
  "pnpm unlink",
  "npm u",
  "npm sit",
  "npm clean-install-test",
  "npm uninst x",
  "npm updat",
  "npm installTest",
  // value-taking flags, listed and unlisted
  "pnpm --store-dir /s add x",
  "pnpm --registry http://r add y",
  "pnpm --network-concurrency 4 install",
  "pnpm --some-future-flag value add x",
  "pnpm --filter test add x",
  "pnpm -rC web add x",
  "npm --audit-level high i",
  "npm --lockfile-version 3 i",
  "npm --some-future-flag value i",
  "yarn --emoji false add x",
  "yarn --some-future-flag value add x",
  "pnpm --socket install",
];

const NATIVE = [
  "pnpm",
  "pnpm run build",
  "pnpm --filter app run add",
  "pnpm exec install",
  "npm run install",
  "npm --version",
  "npm test",
  "yarn --version",
  "yarn run x",
  "yarn --silent --version",
  "yarn --json -h",
  "yarn build",
  "pnpm --some-future-flag value run add",
  "npm cache clean",
  "npm c set x y",
];

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

const fishProbe = (cmd) =>
  spawnSync(
    "fish",
    [
      "-c",
      `function _safe_pkg_prescan; echo scanned; return 1; end
function npm; end; function yarn; end; function pnpm; end
source ${ASSETS}/pnpm-wrapper.fish; source ${ASSETS}/npm-wrapper.fish; source ${ASSETS}/yarn-wrapper.fish
${cmd}`,
    ],
    { encoding: "utf8" },
  );

for (const cmd of SCANNED) {
  test(`fish wrapper scans: ${cmd}`, { skip: !fishAvailable }, () => {
    assert.equal(fishProbe(cmd).stdout.trim(), "scanned");
  });
}
test("zsh and bash agree on every probe", { skip: spawnSync("zsh", ["-c", "true"]).status !== 0 }, () => {
  for (const cmd of [...SCANNED, ...NATIVE]) {
    const script = `_SAFE_PKG_SHARED_LOADED=1
command() { echo NATIVE; }
source "$1/_safe_pkg_shared.sh"; source "$1/pnpm-wrapper.sh"; source "$1/npm-wrapper.sh"; source "$1/yarn-wrapper.sh"
_safe_pkg_dispatch() { echo scanned; }
${cmd}`;
    const z = spawnSync("zsh", ["-c", script, "zsh", ASSETS], { encoding: "utf8" });
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
    const shList = (k) => shBlock.match(new RegExp(`${k}=" ([^"]*) "`))[1].split(" ");
    const fish = read(`${m}-wrapper.fish`);
    const fishList = (k) => fish.match(new RegExp(`set -l ${k} ([^\\n]*)`))[1].split(" ");
    const ps = read(`${m}-wrapper.ps1`);
    const psList = (k) =>
      [...ps.match(new RegExp(`\\$${k} = @\\(([^)]*)\\)`))[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
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
