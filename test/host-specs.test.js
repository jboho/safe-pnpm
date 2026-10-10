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

test("host-specs uses the real name of an alias and skips keys without node_modules/ and links", () => {
  const r = run(
    {
      "": {},
      "node_modules/my-alias": {
        name: "@esbuild/darwin-arm64",
        version: "0.21.5",
        optional: true,
        os: ["darwin"],
      },
      "vendor/x": { version: "1.0.0", optional: true, os: ["darwin"] },
      "node_modules/linked": {
        link: true,
        resolved: "../l",
        optional: true,
        os: ["darwin"],
      },
    },
    ["darwin", "arm64"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "@esbuild/darwin-arm64@0.21.5");
});

test("host-specs refuses a version or name that would become an npm flag", () => {
  const bad = [
    {
      "node_modules/ok": {
        version: "1.0.0 --ignore-scripts=false",
        optional: true,
        os: ["darwin"],
      },
    },
    {
      "node_modules/--registry=http://evil/y": {
        version: "1.0.0",
        optional: true,
        os: ["darwin"],
      },
    },
    {
      "node_modules/ok": {
        version: "1.0.0\n--prefix=/x",
        optional: true,
        os: ["darwin"],
      },
    },
  ];
  for (const packages of bad) {
    const r = run(packages, ["darwin", "arm64"]);
    assert.equal(r.status, 1, JSON.stringify(packages));
    assert.equal(r.stdout.trim(), "");
  }
});

test("host-specs accepts prerelease versions and scoped names", () => {
  const r = run(
    {
      "node_modules/@a/b-c": {
        version: "1.2.3-beta.1+build.5",
        optional: true,
        os: ["darwin"],
      },
    },
    ["darwin", "arm64"],
  );
  assert.equal(r.stdout.trim(), "@a/b-c@1.2.3-beta.1+build.5");
});

test("host-specs warns on a lockfileVersion 1 file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-specs-"));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
  );
  const r = spawnSync("node", [SCRIPT, "darwin", "arm64"], {
    cwd: dir,
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /lockfileVersion 1/);
});
