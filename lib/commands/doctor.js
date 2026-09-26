const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { check: checkVersions } = require("../util/versions");
const { isRunning, imageExists, INSTALL_DIR } = require("../util/docker");
const { detect, hasSourceLine, MARKER } = require("../util/shell");
const { green, red, bold, dim } = require("../util/colors");

const BASE_ASSET_FILES = [
  "Dockerfile",
  "entrypoint.sh",
  "_safe_pkg_shared.sh",
  "_safe_pkg_prescan.fish",
  "_safe_pkg_shared.ps1",
  "malware-scan.js",
  "socket-classify.js",
];

function managerAssetFiles(managers) {
  const files = [];
  for (const mgr of managers) {
    files.push(
      `${mgr}-wrapper.sh`,
      `${mgr}-wrapper.fish`,
      `${mgr}-wrapper.ps1`,
    );
  }
  return files;
}

function row(label, ok, detail, fix) {
  const icon = ok ? green("✓") : red("✗");
  const detailStr = ok
    ? dim(detail)
    : `${detail}${fix ? ` — ${dim(fix)}` : ""}`;
  console.log(`  ${icon}  ${label.padEnd(16)} ${detailStr}`);
}

async function doctor() {
  console.log(`\n${bold("safe-pnpm doctor")}\n`);

  // Read config for enabled managers
  const configPath = path.join(INSTALL_DIR, "config.json");
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      /* use defaults */
    }
  }
  const enabledManagers = config.enabledManagers || ["pnpm"];

  // Docker running
  const dockerRunning = isRunning();
  row(
    "Docker",
    dockerRunning,
    dockerRunning ? "running" : "not running",
    dockerRunning ? null : "start Docker Desktop",
  );

  // Image exists
  const imgOk = imageExists();
  row(
    "Image",
    imgOk,
    imgOk ? "safe-pnpm:latest present" : "safe-pnpm:latest not found",
    imgOk ? null : "run: safe-pnpm update",
  );

  // Installation dir
  const dirOk = fs.existsSync(INSTALL_DIR);
  row(
    "Installation",
    dirOk,
    dirOk ? `${INSTALL_DIR} present` : `${INSTALL_DIR} missing`,
    dirOk ? null : "run: safe-pnpm setup",
  );

  // Wrapper files
  const expectedFiles = [
    ...BASE_ASSET_FILES,
    ...managerAssetFiles(enabledManagers),
  ];
  const missing = expectedFiles.filter(
    (f) => !fs.existsSync(path.join(INSTALL_DIR, f)),
  );
  const filesOk = dirOk && missing.length === 0;
  row(
    "Wrapper files",
    filesOk,
    filesOk
      ? `all ${expectedFiles.length} files present`
      : `missing: ${missing.join(", ")}`,
    filesOk ? null : "run: safe-pnpm update",
  );

  // Shell config
  const shell = detect();
  let shellOk = false;
  let shellDetail = "";
  if (shell.name === "fish") {
    const fishFunctionsDir = path.join(
      os.homedir(),
      ".config",
      "fish",
      "functions",
    );
    const expectedFish = [
      ...enabledManagers.map((mgr) => `${mgr}.fish`),
      "_safe_pkg_prescan.fish",
    ];
    const missingFish = expectedFish.filter(
      (f) => !fs.existsSync(path.join(fishFunctionsDir, f)),
    );
    shellOk = missingFish.length === 0;
    shellDetail = shellOk
      ? `${expectedFish.join(", ")} present`
      : `missing: ${missingFish.join(", ")}`;
  } else if (shell.name === "pwsh") {
    const profileFile = path.join(
      os.homedir(),
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
    if (!fs.existsSync(profileFile)) {
      shellOk = false;
      shellDetail = `PowerShell profile not found: ${profileFile}`;
    } else {
      const content = fs.readFileSync(profileFile, "utf8");
      shellOk = content.includes(MARKER);
      shellDetail = shellOk
        ? `safe-pnpm block found in ${profileFile}`
        : `safe-pnpm block missing from ${profileFile}`;
    }
  } else if (shell.rcFile) {
    shellOk = hasSourceLine(shell.rcFile);
    shellDetail = shellOk
      ? `source line found in ${shell.rcFile}`
      : `source line missing from ${shell.rcFile}`;
  } else {
    shellDetail = "shell not detected";
  }
  row(
    "Shell config",
    shellOk,
    shellDetail,
    shellOk ? null : "run: safe-pnpm setup",
  );

  // Version checks (node + enabled managers + docker)
  const versionChecks = checkVersions(enabledManagers);
  for (const c of versionChecks) {
    if (c.name === "Docker") continue; // already reported above
    row(
      c.name,
      c.ok,
      c.ok ? c.found : `${c.found} (requires ${c.required})`,
      c.ok ? null : `install ${c.name} ${c.required}`,
    );
  }

  // CA cert
  const caCert = process.env.PNPM_SAFE_CA_CERT || "";
  let certOk = false;
  let certDetail = "";
  if (!caCert) {
    certOk = true;
    certDetail = "not configured (no TLS proxy)";
  } else if (fs.existsSync(caCert)) {
    certOk = true;
    certDetail = `PNPM_SAFE_CA_CERT set and file exists`;
  } else {
    certOk = false;
    certDetail = `PNPM_SAFE_CA_CERT set but file not found: ${caCert}`;
  }
  row(
    "CA cert",
    certOk,
    certDetail,
    certOk ? null : "check PNPM_SAFE_CA_CERT path",
  );

  const allOk = [
    dockerRunning,
    imgOk,
    dirOk,
    filesOk,
    shellOk,
    ...versionChecks.filter((c) => c.name !== "Docker").map((c) => c.ok),
    certOk,
  ].every(Boolean);
  console.log("");
  if (allOk) {
    console.log(`  ${green("Everything looks good.")}\n`);
  } else {
    console.log(
      `  ${red("Some checks failed.")} Fix the issues above and re-run ${bold("safe-pnpm doctor")}.\n`,
    );
  }
}

module.exports = doctor;
