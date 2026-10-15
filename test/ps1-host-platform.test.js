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
// pnpm-arch.js is installed in HOME unless opts.noHelper.
function run(manager, osCpu, existingYaml, opts = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "t-"));
  const sandbox = path.join(root, "sandbox");
  fs.mkdirSync(sandbox);
  fs.mkdirSync(path.join(root, ".safe-pnpm"));
  if (!opts.noHelper) {
    fs.copyFileSync(
      path.join(ASSETS, "pnpm-arch.js"),
      path.join(root, ".safe-pnpm", "pnpm-arch.js"),
    );
  }
  if (existingYaml !== undefined)
    fs.writeFileSync(path.join(sandbox, "pnpm-workspace.yaml"), existingYaml);
  if (opts.pkg !== undefined)
    fs.writeFileSync(path.join(sandbox, "package.json"), opts.pkg);
  const args = osCpu ? `-Os ${osCpu[0]} -Cpu ${osCpu[1]}` : "";
  const script = `. /assets/_safe_pkg_shared.ps1; $f = @(_Safe_Pkg_Host_Platform -Manager ${manager} -TmpDir /w/sandbox -Saved /w/arch-saved.json ${args}); 'FLAGS=' + ($f -join ' ')`;
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
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  return {
    out: r.stdout,
    flags: r.stdout.match(/FLAGS=(.*)/)[1].trim(),
    yaml: read(path.join(sandbox, "pnpm-workspace.yaml")),
    pkg: read(path.join(sandbox, "package.json")),
    saved: read(path.join(root, "arch-saved.json")),
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

test("ps1 pnpm 9 pin puts the setting in package.json", { skip }, () => {
  const pkg = '{\n  "packageManager": "pnpm@9.15.0"\n}\n';
  const r = run("pnpm", ["win32", "x64"], undefined, { pkg });
  assert.equal(r.flags, "");
  assert.equal(r.yaml, null);
  assert.equal(r.saved, pkg);
  assert.deepEqual(JSON.parse(r.pkg).pnpm.supportedArchitectures, {
    os: ["current", "win32"],
    cpu: ["current", "x64"],
  });
});

test("ps1 pnpm without pnpm-arch.js warns and changes nothing", {
  skip,
}, () => {
  const r = run("pnpm", ["win32", "x64"], undefined, { noHelper: true });
  assert.equal(r.flags, "");
  assert.equal(r.yaml, null);
  assert.match(r.out, /pnpm-arch\.js missing/);
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

// Runs _Safe_Pkg_Pnpm_Arch_Restore on a snapshot; returns its verdict and the file.
function restore(snapText, savedText) {
  const root = fs.mkdtempSync(path.join(tmp, "r-"));
  fs.mkdirSync(path.join(root, ".safe-pnpm"));
  fs.copyFileSync(
    path.join(ASSETS, "pnpm-arch.js"),
    path.join(root, ".safe-pnpm", "pnpm-arch.js"),
  );
  fs.writeFileSync(path.join(root, "package.json"), snapText);
  fs.writeFileSync(path.join(root, "arch-saved.json"), savedText);
  const script = `. /assets/_safe_pkg_shared.ps1; 'OK=' + (_Safe_Pkg_Pnpm_Arch_Restore /w/package.json /w/arch-saved.json)`;
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
  return {
    out: r.stdout,
    ok: r.stdout.match(/OK=(\w+)/)[1],
    file: fs.readFileSync(path.join(root, "package.json"), "utf8"),
    savedLeft: fs.existsSync(path.join(root, "arch-saved.json")),
  };
}

test("ps1 restore puts the original package.json back", { skip }, () => {
  const orig = '{\n  "packageManager": "pnpm@9.15.0"\n}\n';
  const injected = `${JSON.stringify(
    {
      packageManager: "pnpm@9.15.0",
      pnpm: { supportedArchitectures: { os: ["current", "win32"] } },
    },
    null,
    2,
  )}\n`;
  const r = restore(injected, orig);
  assert.equal(r.ok, "True");
  assert.equal(r.file, orig);
  assert.equal(r.savedLeft, false);
});

test("ps1 restore that fails returns false", { skip }, () => {
  const r = restore("{", "{}");
  assert.equal(r.ok, "False");
  assert.match(r.out, /nothing copied back/);
});
