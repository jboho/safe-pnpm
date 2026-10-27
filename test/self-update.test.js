const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { selfUpdate, isNewer, PACKAGE } = require("../lib/util/self-update");

test("isNewer compares dotted versions numerically", () => {
  assert.equal(isNewer("2026.10.12", "2026.10.11"), true);
  assert.equal(isNewer("2026.10.11", "2026.10.12"), false);
  assert.equal(isNewer("2026.10.10", "2026.10.9"), true);
  assert.equal(isNewer("2026.10.11", "2026.10.11"), false);
  assert.equal(isNewer("2027.1", "2026.10.11"), true);
});

test("selfUpdate does nothing when the installed copy is current", () => {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    return "2026.10.11\n";
  };
  assert.equal(selfUpdate({ installed: "2026.10.11", run }), null);
  assert.deepEqual(calls, [["npm", "view", PACKAGE, "version"]]);
});

test("selfUpdate installs the newer version globally and returns its bin", () => {
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-"));
  const bin = path.join(globalRoot, PACKAGE, "bin", "safe-pnpm.js");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");

  const calls = [];
  const run = (file, args, opts) => {
    calls.push([file, ...args, opts?.inherit ? "inherit" : ""]);
    if (args[0] === "view") return "2026.10.12\n";
    if (args[0] === "root") return `${globalRoot}\n`;
    return null;
  };

  assert.equal(selfUpdate({ installed: "2026.10.11", run }), bin);
  assert.deepEqual(calls, [
    ["npm", "view", PACKAGE, "version", ""],
    ["npm", "install", "-g", `${PACKAGE}@2026.10.12`, "inherit"],
    ["npm", "root", "-g", ""],
  ]);
});

test("selfUpdate refuses a version string that is not dotted digits", () => {
  const run = () => "2026.10.12; rm -rf ~\n";
  assert.throws(
    () => selfUpdate({ installed: "2026.10.11", run }),
    /unexpected version/,
  );
});

test("selfUpdate fails when the registry lookup fails", () => {
  const run = () => {
    throw new Error("ENOTFOUND registry.npmjs.org");
  };
  assert.throws(
    () => selfUpdate({ installed: "2026.10.11", run }),
    /ENOTFOUND/,
  );
});

test("selfUpdate fails when the installed bin is missing after install", () => {
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-"));
  const run = (_file, args) => {
    if (args[0] === "view") return "2026.10.12\n";
    if (args[0] === "root") return `${globalRoot}\n`;
    return null;
  };
  assert.throws(
    () => selfUpdate({ installed: "2026.10.11", run }),
    /is missing/,
  );
});
