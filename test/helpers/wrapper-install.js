const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");

const realDocker = () =>
  spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();

// Runs each of `commands` (argv arrays, e.g. ["install"]) with `manager`
// through the bash wrapper, in one project under `tmp`, against `image`. A
// shim in front of docker swaps the image tag for `image` and logs each
// `docker run`, so a test sees the exact flags the wrapper passed. The host's
// npm, pnpm and yarn are stubs, so the only registry traffic is the
// container's fetch. opts.pkg replaces the project's package.json text;
// opts.mac puts a `uname` reporting Darwin arm64 in front, so the macOS host
// path runs on any host.
function wrapperInstall({ tmp, image, manager, commands = [["install"]], pkg, mac }) {
  const root = fs.mkdtempSync(path.join(tmp, `${manager}-`));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  for (const d of [bin, proj, path.join(home, ".safe-pnpm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of ["link-check.js", "pnpm-arch.js"]) {
    fs.copyFileSync(path.join(ASSETS_DIR, f), path.join(home, ".safe-pnpm", f));
  }
  if (mac) {
    fs.writeFileSync(
      path.join(bin, "uname"),
      '#!/bin/sh\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n',
      { mode: 0o755 },
    );
  }
  const log = path.join(root, "docker-runs.log");
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      `for a in "$@"; do shift; [ "$a" = safe-pnpm:latest ] && a=${image}; set -- "$@" "$a"; done`,
      `[ "$1" = run ] && echo "$@" >> "${log}"`,
      `exec "${realDocker()}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const m of ["npm", "pnpm", "yarn"]) {
    fs.writeFileSync(path.join(bin, m), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(proj, "package.json"),
    pkg ?? JSON.stringify({ name: "e2e", version: "1.0.0", private: true }),
  );
  // Paths go in through the environment, not the script text or argv, so a
  // TMPDIR containing quotes or `$` can't change what bash runs. CodeQL
  // counts every `bash -c` argv element as command text, so argv isn't enough.
  // Each command is one line of SAFE_E2E_COMMANDS, its words separated by tabs.
  const script = [
    'source "$SAFE_E2E_ASSETS/_safe_pkg_shared.sh"',
    'source "$SAFE_E2E_ASSETS/$SAFE_E2E_MANAGER-wrapper.sh"',
    'cd "$SAFE_E2E_PROJ" || exit 1',
    'while IFS=$\'\\t\' read -r -a argv; do "$SAFE_E2E_MANAGER" "${argv[@]}" </dev/null || exit; done <<< "$SAFE_E2E_COMMANDS"',
  ].join("; ");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      SAFE_E2E_ASSETS: ASSETS_DIR,
      SAFE_E2E_MANAGER: manager,
      SAFE_E2E_PROJ: proj,
      SAFE_E2E_COMMANDS: commands.map((argv) => argv.join("\t")).join("\n"),
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      // HOME moved, so point the docker CLI back at the real context config.
      DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(os.homedir(), ".docker"),
      NPM_TOKEN: "",
      NODE_AUTH_TOKEN: "",
      SAFE_PNPM_STRICT: "",
      SAFE_PNPM_OSV_STRICT: "",
    },
  });
  const runs = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { r, proj, runs };
}

module.exports = { ASSETS_DIR, wrapperInstall };
