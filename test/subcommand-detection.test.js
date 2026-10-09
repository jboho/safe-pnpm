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
