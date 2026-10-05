const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHECKER = path.join(__dirname, "..", "assets", "link-check.js");
const { EXIT_PASS, EXIT_FINDINGS, EXIT_FAILED, escapes } = require(CHECKER);

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-links-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The shapes pnpm, npm and yarn write, with the depth of the link's folder.
for (const [target, depth] of [
  [".pnpm/dep@1.0.0/node_modules/dep", 1],
  ["../../dep@1.0.0/node_modules/dep", 4],
  ["../packages/a", 1],
  ["../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep", 3],
  ["../dep/bin/cli.js", 2],
  ["./dep", 1],
]) {
  test(`allowed: ${target} from depth ${depth}`, () => {
    assert.equal(escapes(target, depth), false);
  });
}

for (const [target, depth, why] of [
  ["/etc", 1, "absolute"],
  ["/Users/someone/.ssh", 3, "absolute"],
  ["C:\\Windows", 1, "absolute on Windows"],
  ["..\\..\\..\\Windows", 1, "backslash separators"],
  ["../..", 1, "climbs above the project"],
  ["../../../outside", 2, "climbs above the project"],
  [".pnpm/../../..", 1, "`..` after a plain name"],
  ["s/../..", 1, "`..` after a plain name (s may itself be a link)"],
]) {
  test(`refused (${why}): ${target} from depth ${depth}`, () => {
    assert.equal(escapes(target, depth), true);
  });
}

function check(base, rel) {
  return spawnSync(process.execPath, [CHECKER, base, rel], { stdio: "pipe" });
}

function project(name) {
  const base = path.join(tmp, name);
  const dep = path.join(
    base,
    "node_modules",
    ".pnpm",
    "dep@1.0.0",
    "node_modules",
    "dep",
  );
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, "index.js"), "module.exports=1\n");
  fs.mkdirSync(path.join(base, "packages", "a"), { recursive: true });
  fs.symlinkSync(
    ".pnpm/dep@1.0.0/node_modules/dep",
    path.join(base, "node_modules", "dep"),
  );
  fs.symlinkSync("../packages/a", path.join(base, "node_modules", "a"));
  return base;
}

test("a pnpm-shaped tree passes", () => {
  const base = project("clean");
  const r = check(base, "node_modules");
  assert.equal(r.status, EXIT_PASS, r.stderr.toString());
});

test("an escaping link deep in the tree is a finding naming it", () => {
  const base = project("deep");
  const deep = path.join(
    base,
    "node_modules",
    ".pnpm",
    "dep@1.0.0",
    "node_modules",
  );
  fs.symlinkSync("../../../../../outside", path.join(deep, "evil"));
  fs.symlinkSync("/etc", path.join(base, "node_modules", "abs"));
  const r = check(base, "node_modules");
  assert.equal(r.status, EXIT_FINDINGS);
  const err = r.stderr.toString();
  assert.match(err, /2 link\(s\) in node_modules point outside the project/);
  assert.match(err, /node_modules\/abs -> \/etc/);
  assert.match(err, /dep@1\.0\.0\/node_modules\/evil -> (\.\.\/){5}outside/);
});

test("the walk does not follow a linked directory", () => {
  // node_modules/a -> ../packages/a is allowed; what lies behind it on the
  // sandbox side is never copied back, so a bad link there must not count.
  const base = project("nofollow");
  fs.symlinkSync("/etc", path.join(base, "packages", "a", "evil"));
  const r = check(base, "node_modules");
  assert.equal(r.status, EXIT_PASS, r.stderr.toString());
});

test("a missing tree fails rather than passing", () => {
  const r = check(path.join(tmp, "absent"), "node_modules");
  assert.equal(r.status, EXIT_FAILED);
});

test("missing arguments fail rather than passing", () => {
  const r = spawnSync(process.execPath, [CHECKER], { stdio: "pipe" });
  assert.equal(r.status, EXIT_FAILED);
});
