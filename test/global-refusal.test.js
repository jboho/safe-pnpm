const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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
  ["--global=true", "pkg"],
  ["--global=1", "pkg"],
  ["--prefix", "/x", "-g", "pkg"],
  ["-gg", "pkg"],
  ["global", "add", "pkg"],
  ["global", "remove", "pkg"],
  ["global", "upgrade"],
];
const LOCAL = [
  ["pkg"],
  ["--save-dev", "pkg"],
  ["--location", "project", "pkg"],
  ["--", "-g"],
  ["--legacy-peer-deps", "pkg"],
  ["--global=false", "pkg"],
  ["global", "list"],
];

// `yarn global ...` is a subcommand, covered end to end below.
for (const args of GLOBAL.filter((a) => a[0] !== "global")) {
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

// End to end: the wrapper function itself must refuse before any prescan or
// docker call. A fake docker on PATH records every call.
const WRAPPER_CASES = [
  ["npm", ["install", "-g", "pkg"]],
  ["npm", ["install", "--global=true", "pkg"]],
  ["pnpm", ["add", "-g", "pkg"]],
  ["yarn", ["global", "add", "pkg"]],
];

for (const [mgr, args] of WRAPPER_CASES) {
  test(`sh: ${mgr} ${args.join(" ")} is refused before docker is called`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-glob-"));
    try {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "docker"),
        `#!/bin/sh\necho "$@" >> "${dir}/docker.log"\nexit 1\n`,
        { mode: 0o755 },
      );
      const r = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; source "$2"; shift 2; "$@"',
          "bash",
          SHARED,
          path.join(__dirname, "..", "assets", `${mgr}-wrapper.sh`),
          mgr,
          ...args,
        ],
        {
          stdio: "pipe",
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HOME: dir,
          },
        },
      );
      assert.equal(r.status, 1, r.stderr.toString());
      assert.match(r.stderr.toString(), /global installs are not supported/);
      assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
