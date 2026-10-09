const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;

// Runs _safe_pkg_host_platform with `uname` stubbed to (sys, machine). Returns
// the printed flags and the pnpm-workspace.yaml left in the sandbox dir.
function run(shell, manager, sys, machine, existingYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-"));
  const bin = path.join(dir, "bin");
  const tmp = path.join(dir, "sandbox");
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  fs.writeFileSync(
    path.join(bin, "uname"),
    `#!/bin/sh\nif [ "$1" = -m ]; then echo ${machine}; else echo ${sys}; fi\n`,
    { mode: 0o755 },
  );
  const ws = path.join(tmp, "pnpm-workspace.yaml");
  if (existingYaml !== undefined) fs.writeFileSync(ws, existingYaml);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const r =
    shell === "bash"
      ? spawnSync(
          "bash",
          [
            "-c",
            `source "${ASSETS}/_safe_pkg_shared.sh"; _safe_pkg_host_platform ${manager} "${tmp}"`,
          ],
          { env, encoding: "utf8" },
        )
      : spawnSync(
          "fish",
          [
            "-c",
            `source "${ASSETS}/_safe_pkg_prescan.fish"; _safe_pkg_host_platform ${manager} "${tmp}"`,
          ],
          { env, encoding: "utf8" },
        );
  assert.equal(r.status, 0, r.stderr);
  const yaml = fs.existsSync(ws) ? fs.readFileSync(ws, "utf8") : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout.trim(), yaml };
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
