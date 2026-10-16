const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

// Runs _safe_pkg_host_platform with `uname` stubbed to (sys, machine) and
// pnpm-arch.js installed in a temp HOME (unless opts.noHelper). Returns the
// printed flags, stderr, and the pnpm-workspace.yaml, package.json and saved
// copy left behind.
function run(shell, manager, sys, machine, existingYaml, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
  const bin = path.join(dir, "bin");
  const tmp = path.join(dir, "sandbox");
  const home = path.join(dir, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  fs.mkdirSync(path.join(home, ".safe-pnpm"), { recursive: true });
  if (!opts.noHelper) {
    fs.copyFileSync(
      path.join(ASSETS, "pnpm-arch.js"),
      path.join(home, ".safe-pnpm", "pnpm-arch.js"),
    );
  }
  fs.writeFileSync(
    path.join(bin, "uname"),
    `#!/bin/sh\nif [ "$1" = -m ]; then echo ${machine}; else echo ${sys}; fi\n`,
    { mode: 0o755 },
  );
  const ws = path.join(tmp, "pnpm-workspace.yaml");
  const pkg = path.join(tmp, "package.json");
  const saved = path.join(dir, "arch-saved.json");
  if (existingYaml !== undefined) fs.writeFileSync(ws, existingYaml);
  if (opts.pkg !== undefined) fs.writeFileSync(pkg, opts.pkg);
  // Paths go in through the environment, not the script text or argv: CodeQL
  // counts every `bash -c` argv element as command text.
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SAFE_TEST_ASSETS: ASSETS,
    SAFE_TEST_MANAGER: manager,
    SAFE_TEST_DIR: tmp,
    SAFE_TEST_SAVED: saved,
  };
  const call =
    '_safe_pkg_host_platform "$SAFE_TEST_MANAGER" "$SAFE_TEST_DIR" "$SAFE_TEST_SAVED"';
  const r =
    shell === "bash"
      ? spawnSync(
          "bash",
          ["-c", `source "$SAFE_TEST_ASSETS/_safe_pkg_shared.sh"; ${call}`],
          { env, encoding: "utf8" },
        )
      : spawnSync(
          "fish",
          ["-c", `source "$SAFE_TEST_ASSETS/_safe_pkg_prescan.fish"; ${call}`],
          { env, encoding: "utf8" },
        );
  assert.equal(r.status, 0, r.stderr);
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  const out = {
    out: r.stdout.trim(),
    err: r.stderr,
    yaml: read(ws),
    pkg: read(pkg),
    saved: read(saved),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const shells = [
  ["bash", true],
  ["fish", fishAvailable],
];

for (const [shell, available] of shells) {
  const t = (name, fn) => test(`${shell}: ${name}`, { skip: !available }, fn);

  t("pnpm on Apple Silicon adds the darwin build", () => {
    const r = run(shell, "pnpm", "Darwin", "arm64");
    assert.equal(r.out, "");
    assert.equal(
      r.yaml,
      "supportedArchitectures:\n  os: [current, darwin]\n  cpu: [current, arm64]\n",
    );
  });

  t("pnpm on Intel Mac maps x86_64 to x64", () => {
    assert.match(
      run(shell, "pnpm", "Darwin", "x86_64").yaml,
      /cpu: \[current, x64\]/,
    );
  });

  t("pnpm appends after a file with no trailing newline", () => {
    const r = run(shell, "pnpm", "Darwin", "arm64", "packages:\n  - a");
    assert.ok(r.yaml.startsWith("packages:\n  - a\nsupportedArchitectures:\n"));
  });

  t("pnpm keeps a project's own supportedArchitectures", () => {
    const own = "supportedArchitectures:\n  os: [linux]\n";
    assert.equal(run(shell, "pnpm", "Darwin", "arm64", own).yaml, own);
  });

  t("pnpm ignores a commented-out supportedArchitectures", () => {
    const r = run(
      shell,
      "pnpm",
      "Darwin",
      "arm64",
      "# supportedArchitectures: x\n",
    );
    assert.match(r.yaml, /^supportedArchitectures:/m);
  });

  t("pnpm 9 pin: the setting goes in package.json, not a workspace file", () => {
    const pkg = '{\n  "packageManager": "pnpm@9.15.0"\n}\n';
    const r = run(shell, "pnpm", "Darwin", "arm64", undefined, { pkg });
    assert.equal(r.out, "");
    assert.equal(r.yaml, null);
    assert.equal(r.saved, pkg);
    assert.deepEqual(JSON.parse(r.pkg).pnpm.supportedArchitectures, {
      os: ["current", "darwin"],
      cpu: ["current", "arm64"],
    });
  });

  t("pnpm without pnpm-arch.js warns and changes nothing", () => {
    const r = run(shell, "pnpm", "Darwin", "arm64", undefined, {
      noHelper: true,
    });
    assert.equal(r.out, "");
    assert.equal(r.yaml, null);
    assert.match(r.err, /pnpm-arch\.js missing/);
  });

  t("pnpm on Linux changes nothing", () => {
    assert.equal(run(shell, "pnpm", "Linux", "x86_64").yaml, null);
  });

  t("yarn on macOS ignores platform; on Linux it does not", () => {
    assert.equal(
      run(shell, "yarn", "Darwin", "arm64").out,
      "--ignore-platform",
    );
    assert.equal(run(shell, "yarn", "Linux", "x86_64").out, "");
  });

  t("npm is unchanged", () => {
    const r = run(shell, "npm", "Darwin", "arm64");
    assert.equal(r.out, "");
    assert.equal(r.yaml, null);
  });
}

// Runs _safe_pkg_pnpm_arch_restore on a snapshot holding snapText, with a saved
// original unless savedText is undefined.
function restore(shell, snapText, savedText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".safe-pnpm"), { recursive: true });
  fs.copyFileSync(
    path.join(ASSETS, "pnpm-arch.js"),
    path.join(home, ".safe-pnpm", "pnpm-arch.js"),
  );
  const file = path.join(dir, "package.json");
  const saved = path.join(dir, "arch-saved.json");
  fs.writeFileSync(file, snapText);
  if (savedText !== undefined) fs.writeFileSync(saved, savedText);
  const lib =
    shell === "bash" ? "_safe_pkg_shared.sh" : "_safe_pkg_prescan.fish";
  const r = spawnSync(
    shell,
    [
      "-c",
      `source "${ASSETS}/${lib}"; _safe_pkg_pnpm_arch_restore "${file}" "${saved}"`,
    ],
    { env: { ...process.env, HOME: home }, encoding: "utf8" },
  );
  const out = {
    status: r.status,
    err: r.stderr,
    file: fs.readFileSync(file, "utf8"),
    savedLeft: fs.existsSync(saved),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

for (const [shell, available] of shells) {
  const t = (name, fn) => test(`${shell}: ${name}`, { skip: !available }, fn);
  const orig = '{\n  "packageManager": "pnpm@9.15.0"\n}\n';
  const injected = `${JSON.stringify(
    {
      packageManager: "pnpm@9.15.0",
      pnpm: { supportedArchitectures: { os: ["current", "darwin"] } },
    },
    null,
    2,
  )}\n`;

  t("restore puts the original package.json back", () => {
    const r = restore(shell, injected, orig);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.file, orig);
    assert.equal(r.savedLeft, false);
  });

  t("restore without a saved copy is a no-op", () => {
    const r = restore(shell, injected);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.file, injected);
  });

  t("restore that fails returns 1 and says nothing is copied back", () => {
    const r = restore(shell, "{", orig);
    assert.equal(r.status, 1);
    assert.match(r.err, /nothing copied back/);
  });
}
