const { test } = require("node:test");
const assert = require("node:assert/strict");
const { check } = require("../lib/util/versions");

test("check() defaults to pnpm — returns Node, pnpm, Docker entries", () => {
  const results = check();
  assert.ok(Array.isArray(results));
  const names = results.map((r) => r.name);
  assert.ok(names.includes("Node.js"));
  assert.ok(names.includes("pnpm"));
  assert.ok(names.includes("Docker"));
});

test("check(['npm']) includes npm but not pnpm", () => {
  const results = check(["npm"]);
  const names = results.map((r) => r.name);
  assert.ok(names.includes("npm"));
  assert.ok(!names.includes("pnpm"));
  assert.ok(!names.includes("yarn"));
});

test("check(['pnpm','npm','yarn']) includes all three managers", () => {
  const results = check(["pnpm", "npm", "yarn"]);
  const names = results.map((r) => r.name);
  assert.ok(names.includes("pnpm"));
  assert.ok(names.includes("npm"));
  assert.ok(names.includes("yarn"));
});

test("check([]) omits all managers but still has Node and Docker", () => {
  const results = check([]);
  const names = results.map((r) => r.name);
  assert.ok(names.includes("Node.js"));
  assert.ok(names.includes("Docker"));
  assert.ok(!names.includes("pnpm"));
  assert.ok(!names.includes("npm"));
  assert.ok(!names.includes("yarn"));
});

test("each result has ok, found, and required fields", () => {
  const results = check(["pnpm", "npm", "yarn"]);
  for (const r of results) {
    assert.ok("ok" in r, `${r.name} missing ok`);
    assert.ok("found" in r, `${r.name} missing found`);
    assert.ok("required" in r, `${r.name} missing required`);
  }
});

test("Node.js check passes (we are running in Node)", () => {
  const results = check();
  const node = results.find((r) => r.name === "Node.js");
  assert.ok(node.ok, `Node check failed: found ${node.found}`);
});
