const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MARKER = "# safe-pnpm";
const INSTALL_DIR = path.join(os.homedir(), ".safe-pnpm");

// Shell-safe single-quoting for values written into shell startup files.
// Without this, a CA cert path containing quotes or shell metacharacters would
// execute as code every time the profile loads.

// POSIX sh/bash/zsh: wrap in single quotes; close-escape-reopen embedded quotes.
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// fish: inside single quotes only \ and ' are special.
function fishQuote(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// PowerShell: inside single quotes, ' is escaped by doubling it.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function detect() {
  const shell = process.env.SHELL || "";
  const name = path.basename(shell);

  if (name === "fish") {
    return { name: "fish", rcFile: null };
  }

  if (name === "zsh") {
    return { name: "zsh", rcFile: path.join(os.homedir(), ".zshrc") };
  }

  if (name === "bash") {
    const isMac = process.platform === "darwin";
    return {
      name: "bash",
      rcFile: path.join(os.homedir(), isMac ? ".bash_profile" : ".bashrc"),
    };
  }

  // PowerShell: check $PROFILE equivalent via env
  if (process.env.PSModulePath) {
    return { name: "pwsh", rcFile: null };
  }

  return { name: "unknown", rcFile: null };
}

function hasSourceLine(rcFile) {
  if (!rcFile || !fs.existsSync(rcFile)) return false;
  return fs.readFileSync(rcFile, "utf8").includes(MARKER);
}

// addSourceLines — appends source lines for all enabled managers to rcFile.
// Replaces the old single-manager addSourceLine.
function addSourceLines(rcFile, managers, caCertPath) {
  let block = `\n${MARKER}\n`;
  if (caCertPath) {
    block += `export PNPM_SAFE_CA_CERT=${shQuote(caCertPath)}\n`;
  }
  for (const mgr of managers) {
    block += `source "${path.join(INSTALL_DIR, `${mgr}-wrapper.sh`)}"\n`;
  }
  fs.appendFileSync(rcFile, block, "utf8");
}

// addSourceLine — backward-compatible single-manager form (pnpm only).
function addSourceLine(rcFile, caCertPath) {
  addSourceLines(rcFile, ["pnpm"], caCertPath);
}

// addFishWrappers — copies the prescan helper + each manager's fish function file
// to ~/.config/fish/functions/.
function addFishWrappers(managers, caCertPath) {
  const fishFunctionsDir = path.join(
    os.homedir(),
    ".config",
    "fish",
    "functions",
  );
  fs.mkdirSync(fishFunctionsDir, { recursive: true });

  // shared prescan helper — fish autoloads by function name
  fs.copyFileSync(
    path.join(INSTALL_DIR, "_safe_pkg_prescan.fish"),
    path.join(fishFunctionsDir, "_safe_pkg_prescan.fish"),
  );

  for (const mgr of managers) {
    const src = path.join(INSTALL_DIR, `${mgr}-wrapper.fish`);
    const dest = path.join(fishFunctionsDir, `${mgr}.fish`);
    fs.copyFileSync(src, dest);

    if (caCertPath) {
      const existing = fs.readFileSync(dest, "utf8");
      fs.writeFileSync(
        dest,
        `set -gx PNPM_SAFE_CA_CERT ${fishQuote(caCertPath)}\n${existing}`,
        "utf8",
      );
    }
  }
}

// addFishWrapper — backward-compatible single-manager form (pnpm only).
function addFishWrapper(caCertPath) {
  addFishWrappers(["pnpm"], caCertPath);
}

// addPowerShellWrappers — appends dot-source lines for each enabled manager wrapper.
function addPowerShellWrappers(managers, caCertPath) {
  const profileDir = path.join(os.homedir(), "Documents", "PowerShell");
  const profileFile = path.join(profileDir, "Microsoft.PowerShell_profile.ps1");
  fs.mkdirSync(profileDir, { recursive: true });

  let block = `\n${MARKER}\n`;
  if (caCertPath) {
    block += `$env:PNPM_SAFE_CA_CERT = ${psQuote(caCertPath)}\n`;
  }
  for (const mgr of managers) {
    block += `. "${path.join(INSTALL_DIR, `${mgr}-wrapper.ps1`)}"\n`;
  }

  fs.appendFileSync(profileFile, block, "utf8");
  return profileFile;
}

// addPowerShellWrapper — backward-compatible single-manager form (pnpm only).
function addPowerShellWrapper(caCertPath) {
  return addPowerShellWrappers(["pnpm"], caCertPath);
}

module.exports = {
  detect,
  hasSourceLine,
  addSourceLine,
  addSourceLines,
  addFishWrapper,
  addFishWrappers,
  addPowerShellWrapper,
  addPowerShellWrappers,
  MARKER,
};
