const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1-nb-"));
  if (hasDocker) buildPwshImage();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs _Safe_Pkg_Npm_Host_Builds in pwsh with a `docker` stub that records its
// argv and exits `dockerRc`. Returns what it printed, the recorded argv and
// whether the specs file was left in the sandbox.
function run({ osCpu, specsInstalled = true, dockerRc = 0 }) {
  const root = fs.mkdtempSync(path.join(tmp, "t-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const sandbox = path.join(root, "sandbox");
  for (const d of [path.join(home, ".safe-pnpm"), bin, sandbox])
    fs.mkdirSync(d, { recursive: true });
  if (specsInstalled)
    fs.copyFileSync(
      path.join(ASSETS, "host-specs.js"),
      path.join(home, ".safe-pnpm", "host-specs.js"),
    );
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> /w/docker.log\nls -A /w/sandbox >> /w/seen.log\nexit ${dockerRc}\n`,
    { mode: 0o755 },
  );
  const args = osCpu ? `-Os ${osCpu[0]} -Cpu ${osCpu[1]}` : "";
  const script =
    `$env:PATH = '/w/bin:' + $env:PATH; . /assets/_safe_pkg_shared.ps1; ` +
    `$ok = _Safe_Pkg_Npm_Host_Builds -TmpDir /w/sandbox -Hardening @('--pids-limit','1024') -UserFlags @('--user','1:1') -TokenEnv @('-e','NPM_TOKEN') ${args}; "OK=$ok"`;
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/w/home",
      "-v",
      `${ASSETS}:/assets:ro`,
      "-v",
      `${root}:/w`,
      IMAGE,
      "pwsh",
      "-NoProfile",
      "-Command",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const read = (f) =>
    fs.existsSync(path.join(root, f))
      ? fs.readFileSync(path.join(root, f), "utf8")
      : "";
  return {
    out: r.stdout + r.stderr,
    log: read("docker.log"),
    seen: read("seen.log"),
    left: fs.readdirSync(sandbox),
  };
}

test("ps1 npm host builds run one hardened container with the token and the platform", {
  skip,
}, () => {
  const r = run({ osCpu: ["win32", "x64"] });
  assert.match(r.out, /OK=True/);
  assert.equal(r.log.trim().split("\n").length, 1);
  assert.match(
    r.log.trim(),
    /^run --rm --cap-drop ALL --pids-limit 1024 --user 1:1 -v \/w\/sandbox:\/app -w \/app -e NPM_TOKEN safe-pnpm:latest sh -c .*npm install --no-save --ignore-scripts --force .* sh win32 x64$/,
  );
  assert.match(r.seen, /\.safe-host-specs\.js/);
  assert.deepEqual(r.left, []);
});

test("ps1 npm host builds report a failed install", { skip }, () => {
  const r = run({ osCpu: ["darwin", "arm64"], dockerRc: 1 });
  assert.match(r.out, /OK=False/);
  assert.deepEqual(r.left, []);
});

test("ps1 npm host builds warn and skip when host-specs.js is not installed", {
  skip,
}, () => {
  const r = run({ osCpu: ["darwin", "arm64"], specsInstalled: false });
  assert.match(r.out, /OK=True/);
  assert.match(r.out, /host-specs\.js missing/);
  assert.equal(r.log, "");
});

test("ps1 npm host builds do nothing on a Linux host", { skip }, () => {
  const r = run({});
  assert.match(r.out, /OK=True/);
  assert.equal(r.log, "");
});
