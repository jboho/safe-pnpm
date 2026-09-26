const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

const LOCKFILES = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

const shellAvailable = (sh) =>
  spawnSync(sh, ["--version"], { stdio: "pipe" }).status === 0;
const SHELLS = [
  { shell: "bash", ext: "sh", available: true },
  { shell: "zsh", ext: "sh", available: shellAvailable("zsh") },
  { shell: "fish", ext: "fish", available: shellAvailable("fish") },
];

// Drives a manager wrapper with a stub `docker` on PATH so the two-phase
// orchestration can be inspected without a real daemon or image. The stub
// records each `docker run` invocation and snapshots the sandbox .npmrc at the
// moment of each run, letting us assert exactly what each phase sees.
//
// opts.shell     — shell that sources the wrapper (default bash); fish takes
//                  the .fish wrapper as wrapperFile
// opts.workspace — add a pnpm-workspace.yaml and member packages/a
// opts.phase2    — bash run by the stub during phase 2, with $src = the /app
//                  mount; stands in for an untrusted build script
function runWrapper(manager, wrapperFile, opts = {}) {
  const shell = opts.shell ?? "bash";
  const lockfile = LOCKFILES[manager];
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
  if (opts.workspace) {
    fs.writeFileSync(
      path.join(proj, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    fs.mkdirSync(path.join(proj, "packages", "a"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "packages", "a", "package.json"),
      JSON.stringify({ name: "a", version: "1.0.0" }),
    );
  }

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

# Phase 1 populates node_modules and rewrites the manifest, as a real
# resolving install would, so the copy-back has something to move.
if [ "$n" = "1" ]; then
  mkdir -p "$src/node_modules/dep"
  echo "module.exports=1" > "$src/node_modules/dep/index.js"
  echo '{"name":"fixture","version":"1.0.0","private":true,"dependencies":{"added-by-sandbox":"1.0.0"}}' > "$src/package.json"
  echo "resolved-by-phase-1" > "$src/${lockfile}"
  if [ -d "$src/packages/a" ]; then
    echo '{"name":"a","version":"1.0.0","dependencies":{"member-dep":"1.0.0"}}' > "$src/packages/a/package.json"
    mkdir -p "$src/packages/a/node_modules/member-dep"
    echo "module.exports=1" > "$src/packages/a/node_modules/member-dep/index.js"
  fi
fi
if [ "$n" = "2" ]; then
${opts.phase2 ?? ":"}
fi
exit 0
`;
  const dockerPath = path.join(bin, "docker");
  fs.writeFileSync(dockerPath, stub);
  fs.chmodSync(dockerPath, 0o755);

  const script =
    shell === "fish"
      ? `
source "${path.join(ASSETS_DIR, "_safe_pkg_prescan.fish")}"
source "${path.join(ASSETS_DIR, wrapperFile)}"
cd "${proj}"
${manager} install </dev/null >/dev/null 2>"${log}/stderr"
`
      : `
set -e
source "${path.join(ASSETS_DIR, "_safe_pkg_shared.sh")}"
source "${path.join(ASSETS_DIR, wrapperFile)}"
cd "${proj}"
${manager} install </dev/null >/dev/null 2>"${log}/stderr"
`;
  const r = spawnSync(shell, ["-c", script], {
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
    assert.match(
      p1,
      /--ignore-scripts/,
      "fetch must disable lifecycle scripts",
    );
    assert.match(p1, /-e NPM_TOKEN/, "fetch may carry the registry token");
    assert.doesNotMatch(p1, /--network none/, "fetch needs network");
  });

  test(`${manager}: phase 2 builds with no token and --network none`, () => {
    const { read } = runWrapper(manager, wrapperFile);
    const p2 = read("run2.args");
    assert.match(
      p2,
      /--network none/,
      "build phase must be offline by default",
    );
    assert.doesNotMatch(
      p2,
      /-e NPM_TOKEN/,
      "build phase must not carry the token",
    );
    assert.doesNotMatch(
      p2,
      /-e NODE_AUTH_TOKEN/,
      "build phase must not carry the token",
    );
  });

  test(`${manager}: registry credentials are stripped before the build phase`, () => {
    const { read } = runWrapper(manager, wrapperFile);
    const p1npmrc = read("run1.npmrc");
    const p2npmrc = read("run2.npmrc");
    assert.match(
      p1npmrc,
      /_authToken=SECRET-TOKEN-VALUE/,
      "fetch may see auth",
    );
    assert.doesNotMatch(
      p2npmrc,
      /SECRET-TOKEN-VALUE/,
      "build must not see auth",
    );
    assert.match(
      p2npmrc,
      /node-linker=hoisted/,
      "non-auth config is preserved",
    );
    assert.match(p2npmrc, /@acme:registry=/, "registry config is preserved");
  });

  test(`${manager}: node_modules is copied back to the project`, () => {
    const { proj } = runWrapper(manager, wrapperFile);
    assert.ok(
      fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")),
      "installed tree must land in the project",
    );
  });

  test(`${manager}: a rewritten package.json is copied back to the project`, () => {
    const { proj } = runWrapper(manager, wrapperFile);
    const pkg = fs.readFileSync(path.join(proj, "package.json"), "utf8");
    assert.match(
      pkg,
      /added-by-sandbox/,
      "add/remove manifest changes must land in the project",
    );
  });
}

// Phase 2 runs untrusted build scripts against the /app mount. Anything they
// write outside node_modules must not reach the host: a rewritten manifest
// script or lockfile URL would execute natively on the next host command.
const MALICIOUS_PHASE2 = (lockfile) => `
echo '{"name":"fixture","scripts":{"test":"echo PWNED"}}' > "$src/package.json"
echo "PWNED" > "$src/${lockfile}"
`;

for (const { shell, ext, available } of SHELLS) {
  for (const manager of ["npm", "pnpm", "yarn"]) {
    const wrapperFile = `${manager}-wrapper.${ext}`;
    test(`${manager} (${shell}): phase-2 writes to package.json and the lockfile never reach the host`, {
      skip: !available,
    }, () => {
      const { proj } = runWrapper(manager, wrapperFile, {
        shell,
        phase2: MALICIOUS_PHASE2(LOCKFILES[manager]),
      });
      const pkg = fs.readFileSync(path.join(proj, "package.json"), "utf8");
      assert.doesNotMatch(
        pkg,
        /PWNED/,
        "build scripts must not edit the host manifest",
      );
      assert.match(
        pkg,
        /added-by-sandbox/,
        "the phase-1 manifest edit still lands",
      );
      assert.equal(
        fs.readFileSync(path.join(proj, LOCKFILES[manager]), "utf8").trim(),
        "resolved-by-phase-1",
        "the lockfile comes from the fetch phase",
      );
      assert.ok(
        fs.existsSync(path.join(proj, "node_modules", "dep", "index.js")),
        "the installed tree still lands",
      );
    });
  }

  test(`pnpm workspace (${shell}): member manifests come from phase 1 and new members are not created`, {
    skip: !available,
  }, () => {
    const { proj } = runWrapper("pnpm", `pnpm-wrapper.${ext}`, {
      shell,
      workspace: true,
      phase2: `
echo '{"name":"a","scripts":{"test":"echo PWNED"}}' > "$src/packages/a/package.json"
mkdir -p "$src/packages/evil/node_modules/x"
echo '{"name":"evil","scripts":{"test":"echo PWNED"}}' > "$src/packages/evil/package.json"
mkdir -p "$src/src/node_modules/lodash"
echo "PWNED" > "$src/src/node_modules/lodash/index.js"
`,
    });
    const member = fs.readFileSync(
      path.join(proj, "packages", "a", "package.json"),
      "utf8",
    );
    assert.doesNotMatch(
      member,
      /PWNED/,
      "build scripts must not edit a member manifest",
    );
    assert.match(member, /member-dep/, "the phase-1 member edit still lands");
    assert.ok(
      fs.existsSync(
        path.join(
          proj,
          "packages",
          "a",
          "node_modules",
          "member-dep",
          "index.js",
        ),
      ),
      "member node_modules still lands",
    );
    assert.ok(
      !fs.existsSync(path.join(proj, "packages", "evil")),
      "phase 2 must not create workspace members on the host",
    );
    assert.ok(
      !fs.existsSync(path.join(proj, "src")),
      "phase 2 must not plant node_modules outside the root and members",
    );
  });

  test(`pnpm workspace (${shell}): a node_modules or member dir swapped for a symlink is refused`, {
    skip: !available,
  }, () => {
    const { root, proj, read, status } = runWrapper(
      "pnpm",
      `pnpm-wrapper.${ext}`,
      {
        shell,
        workspace: true,
        // $src/../outside stands in for any path the link could reach.
        phase2: `
mkdir -p "$src/../outside/node_modules"
echo "HOST-SECRET" > "$src/../outside/node_modules/secret"
rm -rf "$src/node_modules" "$src/packages/a"
ln -s "$src/../outside/node_modules" "$src/node_modules"
ln -s "$src/../outside" "$src/packages/a"
`,
      },
    );
    fs.rmSync(path.join(root, "outside"), { recursive: true, force: true });
    assert.notEqual(status, 0, "a refused copy-back must fail the install");
    assert.match(read("stderr"), /not a plain directory/);
    assert.ok(
      !fs.existsSync(path.join(proj, "node_modules")),
      "a symlinked root node_modules must not be copied back",
    );
    assert.ok(
      !fs.existsSync(path.join(proj, "packages", "a", "node_modules")),
      "a member dir swapped for a symlink must not be copied back",
    );
  });
}
