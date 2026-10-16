const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const zshAvailable =
  spawnSync("zsh", ["--version"], { stdio: "pipe" }).status === 0;

// The docker stub runs the container's `sh -c` script on the host, with the
// directory mounted at /app standing in for /app, so host-specs.js really runs
// inside the project's sandbox. `npm` is a stub that records its arguments.
const DOCKER_STUB = `#!/bin/sh
app=
while [ $# -gt 0 ]; do
  case "$1" in
    -v) case "$2" in *:/app) app="\${2%:/app}" ;; esac; shift 2 ;;
    safe-pnpm:latest) shift; break ;;
    *) shift ;;
  esac
done
shift 2
script=$(printf '%s' "$1" | sed "s#/app#$app#g")
shift
cd "$app" && exec sh -c "$script" "$@"
`;

const LOCK = {
  packages: {
    "": { name: "root" },
    "node_modules/@esbuild/darwin-arm64": {
      version: "0.21.5",
      optional: true,
      os: ["darwin"],
      cpu: ["arm64"],
    },
  },
};

function run(shell, pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nhb-"));
  const bin = path.join(dir, "bin");
  const sandbox = path.join(dir, "sandbox");
  const home = path.join(dir, "home");
  for (const d of [bin, sandbox, path.join(home, ".safe-pnpm")])
    fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(
    path.join(ASSETS, "host-specs.js"),
    path.join(home, ".safe-pnpm", "host-specs.js"),
  );
  fs.writeFileSync(
    path.join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = -m ]; then echo arm64; else echo Darwin; fi\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${path.join(dir, "npm.log")}"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(
    path.join(sandbox, "package-lock.json"),
    JSON.stringify(LOCK),
  );
  // Paths go in through the environment, not the script text or argv: CodeQL
  // counts every `bash -c` argv element as command text.
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SAFE_TEST_ASSETS: ASSETS,
    SAFE_TEST_DIR: sandbox,
  };
  const r = spawnSync(
    shell,
    [
      "-c",
      'source "$SAFE_TEST_ASSETS/_safe_pkg_shared.sh"; _safe_pkg_npm_host_builds "$SAFE_TEST_DIR" "" "" ""',
    ],
    { env, encoding: "utf8" },
  );
  const npmLog = path.join(dir, "npm.log");
  const out = {
    status: r.status,
    err: r.stderr,
    npm: fs.existsSync(npmLog) ? fs.readFileSync(npmLog, "utf8").trim() : null,
    left: fs.readdirSync(sandbox).sort(),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

for (const [shell, available] of [
  ["bash", true],
  ["zsh", zshAvailable],
]) {
  const skip = available ? false : `${shell} not available`;

  test(`${shell}: npm host builds work in a project whose package.json sets "type": "module"`, {
    skip,
  }, () => {
    const r = run(shell, { name: "root", type: "module" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.npm ?? "", /-- @esbuild\/darwin-arm64@0\.21\.5$/);
    assert.deepEqual(r.left, ["package-lock.json", "package.json"]);
  });

  test(`${shell}: npm host builds work in a CommonJS project`, {
    skip,
  }, () => {
    const r = run(shell, { name: "root" });
    assert.equal(r.status, 0, r.err);
    assert.match(r.npm ?? "", /-- @esbuild\/darwin-arm64@0\.21\.5$/);
    assert.deepEqual(r.left, ["package-lock.json", "package.json"]);
  });
}
