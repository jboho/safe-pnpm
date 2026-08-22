const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

// Drives a manager wrapper with a stub `docker` on PATH so the two-phase
// orchestration can be inspected without a real daemon or image. The stub
// records each `docker run` invocation and snapshots the sandbox .npmrc at the
// moment of each run, letting us assert exactly what each phase sees.
function runWrapper(manager, wrapperFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-two-phase-"));
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  const log = path.join(root, "log");
  fs.mkdirSync(bin);
  fs.mkdirSync(proj);
  fs.mkdirSync(log);

  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", private: true }),
  );
  // .npmrc mixes a credential line with ordinary config; only the credential
  // must be stripped before the build phase.
  fs.writeFileSync(
    path.join(proj, ".npmrc"),
    [
      "@acme:registry=https://registry.acme.example/",
      "//registry.acme.example/:_authToken=SECRET-TOKEN-VALUE",
      "node-linker=hoisted",
      "",
    ].join("\n"),
  );

  const stub = `#!/usr/bin/env bash
cmd="$1"
if [ "$cmd" = "info" ]; then exit 0; fi
if [ "$cmd" != "run" ]; then exit 0; fi

# Find the host side of the -v SRC:/app mount.
src=""
prev=""
for a in "$@"; do
  case "$prev" in -v) src="\${a%%:/app}" ;; esac
  prev="$a"
done

n=1
[ -f "${log}/count" ] && n=$(( $(cat "${log}/count") + 1 ))
echo "$n" > "${log}/count"

# Record the full invocation and the .npmrc visible to this run.
echo "$@" > "${log}/run$n.args"
[ -f "$src/.npmrc" ] && cp "$src/.npmrc" "${log}/run$n.npmrc" || : > "${log}/run$n.npmrc"

# Phase 1 populates node_modules so the copy-back has something to move.
if [ "$n" = "1" ]; then
  mkdir -p "$src/node_modules/dep"
  echo "module.exports=1" > "$src/node_modules/dep/index.js"
fi
exit 0
`;
  const dockerPath = path.join(bin, "docker");
  fs.writeFileSync(dockerPath, stub);
  fs.chmodSync(dockerPath, 0o755);

  const script = `
set -e
source "${path.join(ASSETS_DIR, "_safe_pkg_shared.sh")}"
source "${path.join(ASSETS_DIR, wrapperFile)}"
cd "${proj}"
${manager} install </dev/null >/dev/null 2>&1
`;
  const r = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root, // keep the prescan from finding a real ~/.safe-pnpm
      NPM_TOKEN: "SECRET-TOKEN-VALUE",
      NODE_AUTH_TOKEN: "SECRET-TOKEN-VALUE",
    },
    stdio: "pipe",
  });

  const runCount = Number(
    fs.readFileSync(path.join(log, "count"), "utf8").trim(),
  );
  const read = (f) => fs.readFileSync(path.join(log, f), "utf8");
  return { root, proj, log, runCount, read, status: r.status };
}

for (const [manager, wrapperFile] of [
  ["npm", "npm-wrapper.sh"],
  ["pnpm", "pnpm-wrapper.sh"],
  ["yarn", "yarn-wrapper.sh"],
]) {
  test(`${manager}: runs exactly two docker phases`, () => {
    const { runCount } = runWrapper(manager, wrapperFile);
    assert.equal(runCount, 2, "expected a fetch phase and a build phase");
  });

  test(`${manager}: phase 1 fetches with token + --ignore-scripts, no --network none`, () => {
    const { read } = runWrapper(manager, wrapperFile);
    const p1 = read("run1.args");
    assert.match(p1, /--ignore-scripts/, "fetch must disable lifecycle scripts");
    assert.match(p1, /-e NPM_TOKEN/, "fetch may carry the registry token");
    assert.doesNotMatch(p1, /--network none/, "fetch needs network");
  });

  test(`${manager}: phase 2 builds with no token and --network none`, () => {
    const { read } = runWrapper(manager, wrapperFile);
    const p2 = read("run2.args");
    assert.match(p2, /--network none/, "build phase must be offline by default");
    assert.doesNotMatch(p2, /-e NPM_TOKEN/, "build phase must not carry the token");
    assert.doesNotMatch(p2, /-e NODE_AUTH_TOKEN/, "build phase must not carry the token");
  });

  test(`${manager}: registry credentials are stripped before the build phase`, () => {
    const { read } = runWrapper(manager, wrapperFile);
    const p1npmrc = read("run1.npmrc");
    const p2npmrc = read("run2.npmrc");
    assert.match(p1npmrc, /_authToken=SECRET-TOKEN-VALUE/, "fetch may see auth");
    assert.doesNotMatch(p2npmrc, /SECRET-TOKEN-VALUE/, "build must not see auth");
    assert.match(p2npmrc, /node-linker=hoisted/, "non-auth config is preserved");
    assert.match(p2npmrc, /@acme:registry=/, "registry config is preserved");
  });

  test(`${manager}: node_modules is copied back to the project`, () => {
    const { proj } = runWrapper(manager, wrapperFile);
    assert.ok(
      fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")),
      "installed tree must land in the project",
    );
  });
}
