const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "assets", "host-specs.js");

const run = (packages, platform) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-specs-"));
  if (packages !== undefined)
    fs.writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ packages }),
    );
  const r = spawnSync("node", [SCRIPT, ...platform], {
    cwd: dir,
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
};

const LOCK = {
  "": { name: "root" },
  "node_modules/esbuild": { version: "0.21.5" },
  "node_modules/@esbuild/darwin-arm64": {
    version: "0.21.5",
    optional: true,
    os: ["darwin"],
    cpu: ["arm64"],
  },
  "node_modules/@esbuild/darwin-x64": {
    version: "0.21.5",
    optional: true,
    os: ["darwin"],
    cpu: ["x64"],
  },
  "node_modules/@esbuild/linux-arm64": {
    version: "0.21.5",
    optional: true,
    os: ["linux"],
    cpu: ["arm64"],
  },
  "node_modules/a/node_modules/@x/win-only": {
    version: "1.0.0",
    optional: true,
    os: ["win32"],
  },
  "node_modules/not-optional": {
    version: "2.0.0",
    os: ["darwin"],
    cpu: ["arm64"],
  },
  "node_modules/notdarwin": {
    version: "3.0.0",
    optional: true,
    os: ["!darwin"],
    cpu: ["arm64"],
  },
};

test("host-specs lists only the host's optional builds", () => {
  const r = run(LOCK, ["darwin", "arm64"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "@esbuild/darwin-arm64@0.21.5");
});

test("host-specs matches an OS-only package and nested paths", () => {
  const r = run(LOCK, ["win32", "x64"]);
  assert.equal(r.stdout.trim(), "@x/win-only@1.0.0");
});

test("host-specs prints nothing for a lockfile without platform packages", () => {
  const r = run({ "": {}, "node_modules/a": { version: "1.0.0" } }, [
    "darwin",
    "arm64",
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("host-specs fails without a lockfile or without arguments", () => {
  assert.notEqual(run(undefined, ["darwin", "arm64"]).status, 0);
  assert.equal(run(LOCK, []).status, 2);
});
