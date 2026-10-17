const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GLOBAL, LOCAL, WRAPPER_CASES } = require("./helpers/wrapper-cases");

const SHARED = path.join(__dirname, "..", "assets", "_safe_pkg_shared.sh");
const PRESCAN = path.join(__dirname, "..", "assets", "_safe_pkg_prescan.fish");

const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

// Fake docker and npm on PATH, in a throwaway directory: if a spelling slips
// past the check, the test fails without a real install landing in the repo.
function fakeBin(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["docker", "npm"]) {
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "$@" >> "${dir}/${tool}.log"\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  return bin;
}

// `yarn global ...` is a subcommand, covered end to end below.
for (const args of GLOBAL.filter((a) => a[0] !== "global")) {
  test(`sh: dispatch refuses "${args.join(" ")}" with exit 1`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-glob-"));
    try {
      const env = {
        ...process.env,
        PATH: `${fakeBin(dir)}:${process.env.PATH}`,
        HOME: dir,
      };
      delete env.SAFE_PNPM_ALLOW_NATIVE_FALLBACK;
      const r = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; shift; _safe_pkg_dispatch npm package-lock.json "" "package.json" install "$@"',
          "bash",
          SHARED,
          ...args,
        ],
        { stdio: "pipe", cwd: dir, env },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr.toString(), /global installs are not supported/);
      assert.match(r.stderr.toString(), /command npm install/);
      assert.equal(fs.existsSync(path.join(dir, "docker.log")), false);
      assert.equal(fs.existsSync(path.join(dir, "npm.log")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
