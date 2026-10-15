const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "assets", "pnpm-arch.js");
const YAML =
  "supportedArchitectures:\n  os: [current, darwin]\n  cpu: [current, arm64]\n";
const ARCH = { os: ["current", "darwin"], cpu: ["current", "arm64"] };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-arch-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function node(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

// Runs `apply` on a sandbox holding the given package.json text and workspace
// yaml. Returns the files afterwards and the saved copy, if any.
function apply(pkgText, wsText) {
  const dir = fs.mkdtempSync(path.join(ROOT, "t-"));
  const box = path.join(dir, "box");
  fs.mkdirSync(box);
  const pkgPath = path.join(box, "package.json");
  const wsPath = path.join(box, "pnpm-workspace.yaml");
  const saved = path.join(dir, "saved.json");
  if (pkgText !== undefined) fs.writeFileSync(pkgPath, pkgText);
  if (wsText !== undefined) fs.writeFileSync(wsPath, wsText);
  const r = node("apply", box, "darwin", "arm64", saved);
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  return {
    r,
    pkgPath,
    saved,
    pkg: read(pkgPath),
    ws: read(wsPath),
    savedText: read(saved),
  };
}

const pin = (v, extra = {}) =>
  `${JSON.stringify({ name: "x", packageManager: `pnpm@${v}`, ...extra }, null, 2)}\n`;

test("no pin: the setting goes in a new pnpm-workspace.yaml, package.json untouched", () => {
  const text = '{\n  "name": "x"\n}\n';
  const a = apply(text);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.r.stdout, "");
  assert.equal(a.ws, YAML);
  assert.equal(a.pkg, text);
  assert.equal(a.savedText, null);
});

test("no package.json: the setting goes in pnpm-workspace.yaml", () => {
  const a = apply(undefined);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.ws, YAML);
});

test("pnpm 9 pin: the setting goes in package.json and the original is saved", () => {
  const text = pin("9.15.0");
  const a = apply(text);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.ws, null);
  assert.equal(a.savedText, text);
  assert.deepEqual(JSON.parse(a.pkg).pnpm, { supportedArchitectures: ARCH });
  assert.equal(JSON.parse(a.pkg).packageManager, "pnpm@9.15.0");
});

test("pnpm 8 pin with an existing pnpm field keeps its other keys", () => {
  const a = apply(pin("8.15.9", { pnpm: { overrides: { a: "1.0.0" } } }));
  assert.deepEqual(JSON.parse(a.pkg).pnpm, {
    overrides: { a: "1.0.0" },
    supportedArchitectures: ARCH,
  });
});

test("pnpm 9 pin leaves a packages-less workspace yaml alone", () => {
  const a = apply(pin("9.15.0"), "packages:\n  - pkgs/*\n");
  assert.equal(a.ws, "packages:\n  - pkgs/*\n");
  assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures);
});

// pnpm 10.0-10.4 reject a workspace file without packages; every 10.x reads
// package.json.
test("pnpm 10 pins use package.json", () => {
  for (const v of ["10.0.0", "10.4.1", "10.18.3"]) {
    const a = apply(pin(v));
    assert.equal(a.ws, null, v);
    assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures, v);
  }
});

test("pnpm 11 and 12 pins use pnpm-workspace.yaml", () => {
  for (const v of ["11.5.3", "11.5.3+sha512.abc", "12.11.2"]) {
    const a = apply(pin(v));
    assert.equal(a.ws, YAML, v);
    assert.equal(a.savedText, null, v);
  }
});

test("pins with a hash or a v prefix are read", () => {
  for (const v of ["9.15.0+sha512.abc", "v9.1.0"]) {
    const a = apply(pin(v));
    assert.equal(a.ws, null, v);
    assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures, v);
  }
});

test("a pnpm 10 project's own yaml setting is kept", () => {
  const own = "packages:\n  - pkgs/*\nsupportedArchitectures:\n  os: [linux]\n";
  const a = apply(pin("10.18.3"), own);
  assert.equal(a.ws, own);
  assert.equal(a.savedText, null);
  assert.equal(JSON.parse(a.pkg).pnpm, undefined);
});

test("an unreadable pnpm pin is treated as old", () => {
  const a = apply(pin("latest"));
  assert.equal(a.ws, null);
  assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures);
});

test("devEngines.packageManager pins are read, as one entry or a list", () => {
  const one = apply(
    `${JSON.stringify({ devEngines: { packageManager: { name: "pnpm", version: "^9.0.0" } } })}\n`,
  );
  assert.equal(one.ws, null);
  assert.ok(JSON.parse(one.pkg).pnpm.supportedArchitectures);
  const list = apply(
    `${JSON.stringify({ devEngines: { packageManager: [{ name: "npm" }, { name: "pnpm", version: "11.x" }] } })}\n`,
  );
  assert.equal(list.ws, YAML);
});

// pnpm 11 resolves a range to the newest matching pnpm (probed: "<10" ran
// 9.15.9, ">=9" ran 12.11.2).
test("devEngines ranges count as old unless they rule out pnpm 10 and earlier", () => {
  const de = (version) =>
    `${JSON.stringify({ devEngines: { packageManager: { name: "pnpm", version } } })}\n`;
  for (const v of ["<10", "^9 || ^11", ">=9", "*", "~10.5.0"]) {
    assert.equal(apply(de(v)).ws, null, v);
  }
  for (const v of ["^11.0.0", "~11.2", ">=11", "12", "11.5.3"]) {
    assert.equal(apply(de(v)).ws, YAML, v);
  }
});

test("devEngines.packageManager wins over packageManager, as in pnpm 11", () => {
  const a = apply(
    pin("11.5.3", {
      devEngines: { packageManager: { name: "pnpm", version: "^9.0.0" } },
    }),
  );
  assert.equal(a.ws, null);
  assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures);
  const b = apply(
    pin("9.15.0", {
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    }),
  );
  assert.equal(b.ws, YAML);
});

test("a project's own setting where its pnpm reads it wins", () => {
  const own = "supportedArchitectures:\n  os: [linux]\n";
  assert.equal(apply('{"name":"x"}', own).ws, own);
  const mine = pin("9.15.0", {
    pnpm: { supportedArchitectures: { os: ["linux"] } },
  });
  const a = apply(mine);
  assert.equal(a.pkg, mine);
  assert.equal(a.savedText, null);
});

test("a setting pnpm 9 does not read does not count as the project's own", () => {
  const a = apply(pin("9.15.0"), "supportedArchitectures:\n  os: [linux]\n");
  assert.ok(JSON.parse(a.pkg).pnpm.supportedArchitectures);
});

test("an invalid package.json or a non-object pnpm field is left alone", () => {
  const bad = '{"name": ';
  assert.equal(apply(bad).pkg, bad);
  assert.equal(apply(bad).ws, null);
  const odd = pin("9.15.0", { pnpm: "x" });
  const a = apply(odd);
  assert.equal(a.pkg, odd);
  assert.equal(a.savedText, null);
});

test("apply keeps the file's indent, line endings, BOM and missing final newline", () => {
  const text = `\uFEFF{\r\n    "name": "x",\r\n    "packageManager": "pnpm@9.15.0"\r\n}`;
  const a = apply(text);
  assert.ok(a.pkg.startsWith('\uFEFF{\r\n    "name": "x",'));
  assert.ok(a.pkg.endsWith("}"));
  assert.ok(!/[^\r]\n/.test(a.pkg));
});

test("restore after no other change writes the original bytes back", () => {
  for (const text of [
    pin("9.15.0"),
    '{\n    "name": "x",\n    "packageManager": "pnpm@9.15.0",\n    "pnpm": {}\n}',
    '{"name":"x","packageManager":"pnpm@8.15.9"}',
  ]) {
    const a = apply(text);
    const r = node("restore", a.pkgPath, a.saved);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(a.pkgPath, "utf8"), text);
    assert.ok(!fs.existsSync(a.saved));
  }
});

test("restore after pnpm add keeps the dependency and other pnpm keys, drops the setting", () => {
  const a = apply(pin("9.15.0", { pnpm: { overrides: { a: "1.0.0" } } }));
  // What pnpm add leaves: the injected key stays, a dependency is added.
  const added = JSON.parse(a.pkg);
  added.dependencies = { esbuild: "^0.24.2" };
  fs.writeFileSync(a.pkgPath, `${JSON.stringify(added, null, 2)}\n`);
  const r = node("restore", a.pkgPath, a.saved);
  assert.equal(r.status, 0, r.stderr);
  const out = fs.readFileSync(a.pkgPath, "utf8");
  assert.deepEqual(JSON.parse(out), {
    name: "x",
    packageManager: "pnpm@9.15.0",
    pnpm: { overrides: { a: "1.0.0" } },
    dependencies: { esbuild: "^0.24.2" },
  });
  assert.ok(out.endsWith("}\n"));
});

test("restore removes a pnpm field it created", () => {
  const a = apply(pin("9.15.0"));
  const added = JSON.parse(a.pkg);
  added.dependencies = { esbuild: "^0.24.2" };
  fs.writeFileSync(a.pkgPath, JSON.stringify(added, null, 2));
  node("restore", a.pkgPath, a.saved);
  assert.equal(JSON.parse(fs.readFileSync(a.pkgPath, "utf8")).pnpm, undefined);
});

test("restore without a saved copy changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "t-"));
  const file = path.join(dir, "package.json");
  const text = '{"pnpm":{"supportedArchitectures":{}}}';
  fs.writeFileSync(file, text);
  const r = node("restore", file, path.join(dir, "none.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("restore fails on a snapshot it cannot parse; bad usage exits 2", () => {
  const a = apply(pin("9.15.0"));
  fs.writeFileSync(a.pkgPath, "{");
  const r = node("restore", a.pkgPath, a.saved);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pnpm-arch:/);
  assert.equal(node("apply", "x").status, 2);
  assert.equal(node().status, 2);
});
