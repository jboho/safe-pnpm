const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const { check: checkVersions } = require("../util/versions");
const { isRunning, buildImage, INSTALL_DIR } = require("../util/docker");
const {
  detect,
  hasSourceLine,
  addSourceLines,
  addFishWrappers,
  addPowerShellWrappers,
} = require("../util/shell");
const { green, red, cyan, bold, dim } = require("../util/colors");

const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");
const PKG_ROOT = path.join(__dirname, "..", "..");

// Files always installed regardless of which managers are enabled
const BASE_ASSET_FILES = [
  "Dockerfile",
  "entrypoint.sh",
  "_safe_pkg_shared.sh",
  "_safe_pkg_prescan.fish",
  "_safe_pkg_shared.ps1",
  "scan-shai-hulud.js",
];

// Per-manager wrapper files (three shells each)
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

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
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

async function setup() {
  console.log(`\n${bold("safe-pnpm setup")}\n`);

  // Already installed?
  if (fs.existsSync(INSTALL_DIR)) {
    console.log(`${cyan("→")} ${INSTALL_DIR} already exists.`);
    console.log(
      `  Run ${bold("safe-pnpm update")} to refresh files, rebuild the image, or add new managers.\n`,
    );
    process.exit(0);
  }

  // Detect available managers
  const detected = detectManagers();
  if (detected.length === 0) {
    console.error(
      red("No package managers found. Install at least one of: pnpm, npm, yarn"),
    );
    process.exit(1);
  }

  // Version checks (always check node + docker; check each detected manager)
  console.log("Checking prerequisites...\n");
  const managerNames = detected.map((m) => m.name);
  const checks = checkVersions(managerNames);
  let failed = false;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  ${green("✓")} ${c.name.padEnd(10)} ${dim(c.found)}`);
    } else {
      console.log(
        `  ${red("✗")} ${c.name.padEnd(10)} ${c.found} — requires ${c.required}`,
      );
      failed = true;
    }
  }
  console.log("");
  if (failed) {
    console.error(
      red("Prerequisites not met. Install the missing tools and try again."),
    );
    process.exit(1);
  }

  // Docker running?
  if (!isRunning()) {
    console.error(
      red("Docker is not running. Start Docker Desktop and try again."),
    );
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let caCertPath = "";
  const enabledManagers = [];
  try {
    const raw = await prompt(
      rl,
      `Corporate CA certificate path (press Enter to skip): `,
    );
    caCertPath = expandHome(raw.trim());
    if (caCertPath && !fs.existsSync(caCertPath)) {
      console.error(red(`File not found: ${caCertPath}`));
      rl.close();
      process.exit(1);
    }

    // Per-manager enable prompts
    console.log(`\nDetected package managers:\n`);
    for (const { name, version } of detected) {
      const ans = await prompt(
        rl,
        `  Enable ${name.padEnd(6)} ${dim(`(${version})`)}  [Y/n] `,
      );
      if (ans.trim() === "" || /^[Yy]/i.test(ans)) {
        enabledManagers.push(name);
      }
    }
  } finally {
    rl.close();
  }

  if (enabledManagers.length === 0) {
    console.error(red("\nNo managers enabled. Exiting."));
    process.exit(1);
  }

  console.log("");

  // Copy assets to ~/.safe-pnpm/
  console.log(`${cyan("→")} Creating ${INSTALL_DIR}...`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  const allAssets = [...BASE_ASSET_FILES, ...managerAssetFiles(enabledManagers)];
  for (const file of allAssets) {
    fs.copyFileSync(path.join(ASSETS_DIR, file), path.join(INSTALL_DIR, file));
  }
  // Make shell scripts executable
  const executableSh = ["entrypoint.sh", ...enabledManagers.map((m) => `${m}-wrapper.sh`)];
  for (const file of executableSh) {
    fs.chmodSync(path.join(INSTALL_DIR, file), 0o755);
  }
  installSocketWrapper();

  // Write config
  const pkg = require("../../package.json");
  fs.writeFileSync(
    path.join(INSTALL_DIR, "config.json"),
    JSON.stringify(
      {
        caCertPath: caCertPath || null,
        installedVersion: pkg.version,
        enabledManagers,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Build Docker image
  console.log(
    `${cyan("→")} Building Docker image (this takes a minute the first time)...\n`,
  );
  buildImage(caCertPath || null);
  console.log("");

  // Wire shell config
  const shell = detect();
  if (shell.name === "fish") {
    console.log(`${cyan("→")} Wiring fish shell wrappers...`);
    addFishWrappers(enabledManagers, caCertPath || null);
    console.log(`  Copied ${enabledManagers.map((m) => `${m}.fish`).join(", ")} to ~/.config/fish/functions/`);
  } else if (shell.name === "pwsh") {
    console.log(`${cyan("→")} Wiring PowerShell wrappers...`);
    const profileFile = addPowerShellWrappers(enabledManagers, caCertPath || null);
    console.log(`  Appended source lines to ${profileFile}`);
  } else if (shell.rcFile) {
    if (hasSourceLine(shell.rcFile)) {
      console.log(
        `${dim(`  ${shell.rcFile} already has safe-pnpm source line — skipping`)}`,
      );
    } else {
      console.log(`${cyan("→")} Adding source lines to ${shell.rcFile}...`);
      addSourceLines(shell.rcFile, enabledManagers, caCertPath || null);
    }
  } else {
    console.log(
      `${cyan("→")} Shell not detected. Add this to your shell config manually:`,
    );
    if (caCertPath) console.log(`  export PNPM_SAFE_CA_CERT="${caCertPath}"`);
    for (const mgr of enabledManagers) {
      console.log(`  source "${path.join(INSTALL_DIR, `${mgr}-wrapper.sh`)}"`);
    }
  }

  console.log(`\n${green("✓")} safe-pnpm is installed (${enabledManagers.join(", ")}).\n`);

  if (shell.rcFile && shell.name !== "fish" && shell.name !== "pwsh") {
    console.log(`Reload your shell to activate:\n`);
    console.log(`  ${bold(`source ${shell.rcFile}`)}\n`);
  } else if (shell.name === "fish") {
    console.log(
      `Open a new terminal or run ${bold("exec fish")} to activate.\n`,
    );
  } else if (shell.name === "pwsh") {
    console.log(`Reload your profile: ${bold(". $PROFILE")}\n`);
  }

  console.log(`Then verify with: ${bold("safe-pnpm doctor")}\n`);
}

module.exports = setup;
