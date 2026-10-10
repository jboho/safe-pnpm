const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1-hp-"));
  if (hasDocker) buildPwshImage();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs _Safe_Pkg_Host_Platform in pwsh. Without osCpu the host's own platform
// is used, which inside the Linux test image must change nothing.
function run(manager, osCpu, existingYaml) {
  const root = fs.mkdtempSync(path.join(tmp, "t-"));
  const sandbox = path.join(root, "sandbox");
  fs.mkdirSync(sandbox);
  if (existingYaml !== undefined)
    fs.writeFileSync(path.join(sandbox, "pnpm-workspace.yaml"), existingYaml);
  const args = osCpu ? `-Os ${osCpu[0]} -Cpu ${osCpu[1]}` : "";
  const script = `. /assets/_safe_pkg_shared.ps1; $f = @(_Safe_Pkg_Host_Platform -Manager ${manager} -TmpDir /w/sandbox ${args}); 'FLAGS=' + ($f -join ' ')`;
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/w",
      "-v",
      `${ASSETS}:/assets:ro`,
      "-v",
      `${root}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-Command",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const ws = path.join(sandbox, "pnpm-workspace.yaml");
  return {
    flags: r.stdout.match(/FLAGS=(.*)/)[1].trim(),
    yaml: fs.existsSync(ws) ? fs.readFileSync(ws, "utf8") : null,
  };
}

test("ps1 pnpm on Windows adds the win32 build", { skip }, () => {
  const r = run("pnpm", ["win32", "x64"]);
  assert.equal(r.flags, "");
  assert.equal(
    r.yaml,
    "supportedArchitectures:\n  os: [current, win32]\n  cpu: [current, x64]\n",
  );
});

test("ps1 pnpm on a Mac adds the darwin build", { skip }, () => {
  assert.match(
    run("pnpm", ["darwin", "arm64"]).yaml,
    /os: \[current, darwin\]\n {2}cpu: \[current, arm64\]/,
  );
});

test("ps1 pnpm appends after a file with no trailing newline", { skip }, () => {
  const r = run("pnpm", ["win32", "x64"], "packages:\n  - a");
  assert.ok(r.yaml.startsWith("packages:\n  - a\nsupportedArchitectures:\n"));
});

test("ps1 pnpm keeps a project's own supportedArchitectures", { skip }, () => {
  const own = "supportedArchitectures:\n  os: [linux]\n";
  assert.equal(run("pnpm", ["win32", "x64"], own).yaml, own);
});

test("ps1 pnpm ignores a commented-out supportedArchitectures", {
  skip,
}, () => {
  const r = run("pnpm", ["win32", "x64"], "# supportedArchitectures: x\n");
  assert.match(r.yaml, /^supportedArchitectures:/m);
});

test("ps1 yarn ignores platform on Windows", { skip }, () => {
  assert.equal(run("yarn", ["win32", "x64"]).flags, "--ignore-platform");
});

test("ps1 npm is unchanged", { skip }, () => {
  const r = run("npm", ["win32", "x64"]);
  assert.equal(r.flags, "");
  assert.equal(r.yaml, null);
});

test("ps1 on a Linux host changes nothing", { skip }, () => {
  const r = run("pnpm");
  assert.equal(r.flags, "");
  assert.equal(r.yaml, null);
});
