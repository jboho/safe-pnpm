const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const IMAGE = "safe-pnpm:latest";
const INSTALL_DIR = path.join(os.homedir(), ".safe-pnpm");

function isRunning() {
  const r = spawnSync("docker", ["info"], { stdio: "pipe" });
  return r.status === 0;
}

function imageExists() {
  const r = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "pipe" });
  return r.status === 0;
}

function buildImage(caCertPath) {
  const args = ["build", "-t", IMAGE];

  if (caCertPath && fs.existsSync(caCertPath)) {
    const certContent = fs.readFileSync(caCertPath, "utf8");
    args.push("--build-arg", `CUSTOM_CA=${certContent}`);
  }

  args.push(INSTALL_DIR);

  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`docker build exited with code ${r.status}`);
  }
}

function getManagerVersion(manager) {
  try {
    return execFileSync(
      "docker",
      ["run", "--rm", IMAGE, manager, "--version"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return null;
  }
}

function getPnpmVersion() {
  return getManagerVersion("pnpm");
}

module.exports = {
  isRunning,
  imageExists,
  buildImage,
  getManagerVersion,
  getPnpmVersion,
  IMAGE,
  INSTALL_DIR,
};
