const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detect,
  hasSourceLine,
  addSourceLine,
  addSourceLines,
  MARKER,
} = require("../lib/util/shell");

test("detect() returns a name and rcFile", () => {
  const shell = detect();
  assert.ok(typeof shell.name === "string");
  // rcFile may be null for unknown/pwsh, but must be present as a key
  assert.ok("rcFile" in shell);
});

test("hasSourceLine() returns false for a file without the marker", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  fs.writeFileSync(tmp, "# some shell config\nexport FOO=bar\n");
  assert.equal(hasSourceLine(tmp), false);
  fs.unlinkSync(tmp);
});

test("hasSourceLine() returns true after addSourceLine()", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  fs.writeFileSync(tmp, "# some shell config\n");
  addSourceLine(tmp, null);
  assert.ok(hasSourceLine(tmp));
  const content = fs.readFileSync(tmp, "utf8");
  assert.ok(content.includes(MARKER));
  assert.ok(content.includes(".safe-pnpm/pnpm-wrapper.sh"));
  fs.unlinkSync(tmp);
});

test("addSourceLine() includes cert export when caCertPath provided", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  fs.writeFileSync(tmp, "");
  addSourceLine(tmp, "/path/to/cert.pem");
  const content = fs.readFileSync(tmp, "utf8");
  assert.ok(content.includes("PNPM_SAFE_CA_CERT='/path/to/cert.pem'"));
  fs.unlinkSync(tmp);
});

test("addSourceLines() neutralizes shell metacharacters in cert path", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  const pwnedMarker = path.join(os.tmpdir(), `safe-pnpm-pwned-${Date.now()}`);
  const malicious = `/tmp/cert.pem";touch ${pwnedMarker};echo "`;
  fs.writeFileSync(tmp, "");
  addSourceLines(tmp, ["pnpm"], malicious);

  const exportLine = fs
    .readFileSync(tmp, "utf8")
    .split("\n")
    .find((l) => l.startsWith("export PNPM_SAFE_CA_CERT="));

  const probe = path.join(os.tmpdir(), `safe-pnpm-probe-${Date.now()}.sh`);
  fs.writeFileSync(probe, `${exportLine}\nprintf '%s' "$PNPM_SAFE_CA_CERT"\n`);
  const r = spawnSync("bash", [probe], { encoding: "utf8" });

  // Variable holds the literal path; the injected command never executed.
  assert.equal(r.stdout, malicious);
  assert.equal(fs.existsSync(pwnedMarker), false);

  fs.unlinkSync(tmp);
  fs.unlinkSync(probe);
});

test("addSourceLines() writes a source line for each manager", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  fs.writeFileSync(tmp, "# existing config\n");
  addSourceLines(tmp, ["pnpm", "npm", "yarn"], null);
  const content = fs.readFileSync(tmp, "utf8");
  assert.ok(content.includes(MARKER));
  assert.ok(content.includes("pnpm-wrapper.sh"));
  assert.ok(content.includes("npm-wrapper.sh"));
  assert.ok(content.includes("yarn-wrapper.sh"));
  fs.unlinkSync(tmp);
});

test("addSourceLines() includes cert export once when caCertPath provided", () => {
  const tmp = path.join(os.tmpdir(), `safe-pnpm-test-${Date.now()}.sh`);
  fs.writeFileSync(tmp, "");
  addSourceLines(tmp, ["pnpm", "npm"], "/certs/corp.pem");
  const content = fs.readFileSync(tmp, "utf8");
  assert.equal(
    (content.match(/PNPM_SAFE_CA_CERT/g) || []).length,
    1,
    "cert export should appear exactly once",
  );
  fs.unlinkSync(tmp);
});

test("addSourceLines() with single manager behaves like addSourceLine()", () => {
  const tmp1 = path.join(os.tmpdir(), `safe-pnpm-test-a-${Date.now()}.sh`);
  const tmp2 = path.join(os.tmpdir(), `safe-pnpm-test-b-${Date.now()}.sh`);
  fs.writeFileSync(tmp1, "");
  fs.writeFileSync(tmp2, "");
  addSourceLine(tmp1, null);
  addSourceLines(tmp2, ["pnpm"], null);
  assert.equal(fs.readFileSync(tmp1, "utf8"), fs.readFileSync(tmp2, "utf8"));
  fs.unlinkSync(tmp1);
  fs.unlinkSync(tmp2);
});
