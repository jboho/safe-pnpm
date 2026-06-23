const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const { buildImage, getManagerVersion, INSTALL_DIR } = require("../util/docker");
const {
  detect,
  addSourceLines,
  addFishWrappers,
  addPowerShellWrappers,
} = require("../util/shell");
const { green, red, cyan, bold, dim } = require("../util/colors");

const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");
const PKG_ROOT = path.join(__dirname, "..", "..");

const BASE_ASSET_FILES = [
  "Dockerfile",
  "entrypoint.sh",
  "_safe_pkg_shared.sh",
  "_safe_pkg_prescan.fish",
  "_safe_pkg_shared.ps1",
  "scan-shai-hulud.js",
];

function managerAssetFiles(managers) {
  const files = [];
  for (const mgr of managers) {
    files.push(`${mgr}-wrapper.sh`, `${mgr}-wrapper.fish`, `${mgr}-wrapper.ps1`);
  }
  return files;
}

function installSocketWrapper() {
  const socketBin = path.join(
    PKG_ROOT,
    "node_modules",
    "@socketsecurity",
    "cli",
    "bin",
    "cli.js",
  );
  if (!fs.existsSync(socketBin)) return;
  const wrapper = `#!/bin/sh\nexec node "${socketBin}" "$@"\n`;
  fs.writeFileSync(path.join(INSTALL_DIR, "socket"), wrapper, { mode: 0o755 });
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function detectManagers() {
  const managers = [];
  for (const mgr of ["pnpm", "npm", "yarn"]) {
    try {
      const ver = execFileSync(mgr, ["--version"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      managers.push({ name: mgr, version: ver });
    } catch {
      // not installed
    }
  }
  return managers;
}

async function update() {
  console.log(`\n${bold("safe-pnpm update")}\n`);

  if (!fs.existsSync(INSTALL_DIR)) {
    console.error(
      red(`${INSTALL_DIR} not found. Run ${bold("safe-pnpm setup")} first.`),
    );
    process.exit(1);
  }

  // Read existing config
  const configPath = path.join(INSTALL_DIR, "config.json");
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      /* use defaults */
    }
  }
  // Default to pnpm-only for installations that predate multi-manager support
  const enabledManagers = config.enabledManagers || ["pnpm"];

  // Detect managers installed on the machine that aren't yet enabled
  const detected = detectManagers();
  const newManagers = detected.filter((m) => !enabledManagers.includes(m.name));

  const addedManagers = [];
  if (newManagers.length > 0) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log("New package managers detected:\n");
      for (const { name, version } of newManagers) {
        const ans = await prompt(
          rl,
          `  Enable ${name.padEnd(6)} ${dim(`(${version})`)}  [y/N] `,
        );
        if (/^[Yy]/i.test(ans)) {
          addedManagers.push(name);
        }
      }
    } finally {
      rl.close();
    }
    if (addedManagers.length > 0) console.log("");
  }

  const allManagers = [...enabledManagers, ...addedManagers];

  // Re-copy all assets
  console.log(`${cyan("→")} Refreshing wrapper files...`);
  const allAssets = [...BASE_ASSET_FILES, ...managerAssetFiles(allManagers)];
  for (const file of allAssets) {
    const src = path.join(ASSETS_DIR, file);
    const dest = path.join(INSTALL_DIR, file);
    fs.copyFileSync(src, dest);
  }
  const executableSh = ["entrypoint.sh", ...allManagers.map((m) => `${m}-wrapper.sh`)];
  for (const file of executableSh) {
    fs.chmodSync(path.join(INSTALL_DIR, file), 0o755);
  }
  installSocketWrapper();

  // Wire newly added managers into shell config
  if (addedManagers.length > 0) {
    const shell = detect();
    const caCertPath = config.caCertPath || null;
    if (shell.name === "fish") {
      console.log(`${cyan("→")} Wiring fish wrappers for ${addedManagers.join(", ")}...`);
      addFishWrappers(addedManagers, caCertPath);
    } else if (shell.name === "pwsh") {
      console.log(`${cyan("→")} Wiring PowerShell wrappers for ${addedManagers.join(", ")}...`);
      addPowerShellWrappers(addedManagers, caCertPath);
    } else if (shell.rcFile) {
      console.log(`${cyan("→")} Adding source lines to ${shell.rcFile}...`);
      // Append only new managers to avoid duplicating the existing block
      addSourceLines(shell.rcFile, addedManagers, null);
    }
  }

  // Rebuild image
  console.log(`${cyan("→")} Rebuilding Docker image...\n`);
  buildImage(config.caCertPath || null);
  console.log("");

  // Update config
  const pkg = require("../../package.json");
  config.installedVersion = pkg.version;
  config.enabledManagers = allManagers;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  // Report manager versions in new image
  for (const mgr of allManagers) {
    const ver = getManagerVersion(mgr);
    if (ver) console.log(`${dim(`${mgr} in image:`)} ${ver}`);
  }

  const added = addedManagers.length > 0
    ? ` (added: ${addedManagers.join(", ")})`
    : "";
  console.log(`\n${green("✓")} safe-pnpm updated to ${pkg.version}${added}\n`);

  if (addedManagers.length > 0) {
    const shell = detect();
    if (shell.rcFile && shell.name !== "fish" && shell.name !== "pwsh") {
      console.log(`Reload your shell to activate the new wrappers:\n`);
      console.log(`  ${bold(`source ${shell.rcFile}`)}\n`);
    }
  }
}

module.exports = update;
