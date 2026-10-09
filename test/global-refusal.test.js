const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SHARED = path.join(__dirname, "..", "assets", "_safe_pkg_shared.sh");
const PRESCAN = path.join(__dirname, "..", "assets", "_safe_pkg_prescan.fish");

const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

const GLOBAL = [
  ["-g", "pkg"],
  ["pkg", "-g"],
  ["-gD", "pkg"],
  ["--global", "pkg"],
  ["--location=global", "pkg"],
  ["--location", "global", "pkg"],
];
const LOCAL = [
  ["pkg"],
  ["--save-dev", "pkg"],
  ["--location", "project", "pkg"],
  ["--", "-g"],
  ["--legacy-peer-deps", "pkg"],
];

for (const args of GLOBAL) {
  test(`sh: dispatch refuses "${args.join(" ")}" with exit 1`, () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; shift; _safe_pkg_dispatch npm package-lock.json "" "package.json" install "$@"',
        "bash",
        SHARED,
        ...args,
      ],
      { stdio: "pipe", cwd: __dirname },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr.toString(), /global installs are not supported/);
    assert.match(r.stderr.toString(), /command npm install/);
  });
}

for (const [list, expected] of [
  [GLOBAL, 0],
  [LOCAL, 1],
]) {
  for (const args of list) {
    test(`sh: _safe_pkg_is_global "${args.join(" ")}" -> ${expected}`, () => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; shift; _safe_pkg_is_global "$@"',
          "bash",
          SHARED,
          ...args,
        ],
        { stdio: "pipe" },
      );
      assert.equal(r.status, expected);
    });
    test(`fish: _safe_pkg_is_global "${args.join(" ")}" -> ${expected}`, {
      skip: !fishAvailable,
    }, () => {
      const r = spawnSync(
        "fish",
        [
          "-c",
          "source $argv[1]; _safe_pkg_is_global $argv[2..-1]",
          PRESCAN,
          ...args,
        ],
        { stdio: "pipe" },
      );
      assert.equal(r.status, expected);
    });
  }
}
