const { spawnSync } = require("node:child_process");

const IMAGE = "safe-pnpm-pwsh-test";
// The powershell image is amd64-only, so the node binary must match.
const DOCKERFILE = [
  "FROM --platform=linux/amd64 mcr.microsoft.com/powershell:lts-debian-12",
  "COPY --from=docker.io/library/node:22 /usr/local/bin/node /usr/local/bin/node",
].join("\n");

const hasDocker =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

function buildPwshImage() {
  const b = spawnSync(
    "docker",
    ["build", "-q", "--platform", "linux/amd64", "-t", IMAGE, "-"],
    { input: DOCKERFILE, encoding: "utf8" },
  );
  if (b.status !== 0) throw new Error(`pwsh image build failed: ${b.stderr}`);
}

module.exports = { IMAGE, hasDocker, buildPwshImage };
