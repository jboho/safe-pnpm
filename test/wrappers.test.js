const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

const SH_WRAPPERS = [
  "_safe_pkg_shared.sh",
  "pnpm-wrapper.sh",
  "npm-wrapper.sh",
  "yarn-wrapper.sh",
];

const FISH_WRAPPERS = [
  "_safe_pkg_prescan.fish",
  "pnpm-wrapper.fish",
  "npm-wrapper.fish",
  "yarn-wrapper.fish",
];

for (const file of SH_WRAPPERS) {
  test(`${file} passes bash syntax check`, () => {
    const r = spawnSync("bash", ["-n", path.join(ASSETS_DIR, file)], {
      stdio: "pipe",
    });
    assert.equal(
      r.status,
      0,
      `bash -n failed for ${file}: ${r.stderr?.toString()}`,
    );
  });
}

const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

for (const file of FISH_WRAPPERS) {
  test(`${file} passes fish syntax check`, { skip: !fishAvailable }, () => {
    const r = spawnSync("fish", ["-n", path.join(ASSETS_DIR, file)], {
      stdio: "pipe",
    });
    assert.equal(
      r.status,
      0,
      `fish -n failed for ${file}: ${r.stderr?.toString()}`,
    );
  });
}
