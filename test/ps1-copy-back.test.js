const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const IMAGE = "safe-pnpm-pwsh-test";
// The powershell image is amd64-only, so the node binary must match.
const DOCKERFILE = [
  "FROM --platform=linux/amd64 mcr.microsoft.com/powershell:lts-debian-12",
  "COPY --from=docker.io/library/node:22 /usr/local/bin/node /usr/local/bin/node",
].join("\n");

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const skip = hasDocker ? false : "docker not available";

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1-"));
  if (!hasDocker) return;
  const b = spawnSync("docker", ["build", "-q", "--platform", "linux/amd64", "-t", IMAGE, "-"], {
    input: DOCKERFILE,
    encoding: "utf8",
  });
  assert.equal(b.status, 0, b.stderr);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs _Safe_Pkg_Copy_Modules for `rel` in pwsh. `home` is the fake $HOME that
// holds (or lacks) ~/.safe-pnpm/link-check.js.
function copyBack({ name, build, rel = "node_modules", installChecker = true, pathOnly = false }) {
  const root = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const src = path.join(root, "src");
  const dest = path.join(root, "dest");
  const home = path.join(root, "home");
  for (const d of [src, dest, home, path.join(home, ".safe-pnpm")]) fs.mkdirSync(d);
  if (installChecker) {
    fs.copyFileSync(
      path.join(ASSETS, "link-check.js"),
      path.join(home, ".safe-pnpm", "link-check.js"),
    );
  }
  build(src);
  // `& /bin/true` first leaves $LASTEXITCODE at 0, the state a missing node
  // must not be mistaken for a pass in. PATH is narrowed after pwsh starts.
  const script =
    `. /assets/_safe_pkg_shared.ps1; ` +
    (pathOnly ? `& /bin/true; $env:PATH = '/usr/bin:/bin'; ` : "") +
    `if (_Safe_Pkg_Copy_Modules -Base /w/src -Rel '${rel}' -DestRoot /w/dest) { 'RESULT=true' } else { 'RESULT=false' }`;
  const r = spawnSync(
    "docker",
    [
      "run", "--rm", "--platform", "linux/amd64",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "HOME=/h",
      "-v", `${ASSETS}:/assets:ro`,
      "-v", `${root}:/w`,
      "-v", `${home}:/h`,
      IMAGE, "pwsh", "-NoProfile", "-Command", script,
    ],
    { encoding: "utf8" },
  );
  return { r, dest, out: r.stdout + r.stderr };
}

const plainTree = (src) => {
  const nm = path.join(src, "node_modules");
  fs.mkdirSync(path.join(nm, ".pnpm", "dep@1.0.0", "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(nm, ".pnpm", "dep@1.0.0", "node_modules", "dep", "index.js"), "ok");
  fs.symlinkSync(".pnpm/dep@1.0.0/node_modules/dep", path.join(nm, "dep"));
};

test("ps1 copy-back keeps links as links", { skip }, () => {
  const { dest, out } = copyBack({ name: "keep", build: plainTree });
  assert.match(out, /RESULT=true/);
  const link = path.join(dest, "node_modules", "dep");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "dep must stay a symlink");
  assert.equal(fs.readlinkSync(link), ".pnpm/dep@1.0.0/node_modules/dep");
  assert.equal(fs.readFileSync(path.join(link, "index.js"), "utf8"), "ok");
});

test("ps1 copy-back refuses a link that escapes the project", { skip }, () => {
  const { dest, out } = copyBack({
    name: "escape",
    build: (src) => {
      plainTree(src);
      fs.symlinkSync("/etc", path.join(src, "node_modules", "outside"));
    },
  });
  assert.match(out, /RESULT=false/);
  assert.match(out, /outside/, "the checker names the offending link");
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")), "nothing copied");
});

test("ps1 copy-back fails closed without the link checker", { skip }, () => {
  const { dest, out } = copyBack({ name: "nochecker", build: plainTree, installChecker: false });
  assert.match(out, /link check not installed/);
  assert.match(out, /RESULT=false/);
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")));
});

test("ps1 copy-back refuses a node_modules that is itself a link", { skip }, () => {
  const { dest, out } = copyBack({
    name: "rootlink",
    build: (src) => {
      fs.mkdirSync(path.join(src, "real"));
      fs.symlinkSync("real", path.join(src, "node_modules"));
    },
  });
  assert.match(out, /not a plain directory/);
  assert.match(out, /RESULT=false/);
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")));
});

test("ps1 copy-back refuses when node is not on PATH", { skip }, () => {
  const { dest, out } = copyBack({
    name: "nonode",
    pathOnly: true,
    build: (src) => {
      plainTree(src);
      fs.symlinkSync("/etc", path.join(src, "node_modules", "outside"));
    },
  });
  assert.match(out, /node not found/);
  assert.match(out, /RESULT=false/);
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")));
});

test("ps1 copy-back reports a copy that fails partway", { skip }, () => {
  const { dest, out } = copyBack({
    name: "partial",
    build: (src) => {
      plainTree(src);
      const f = path.join(src, "node_modules", "unreadable.js");
      fs.writeFileSync(f, "x");
      fs.chmodSync(f, 0o000);
    },
  });
  assert.match(out, /copying node_modules back failed/);
  assert.match(out, /RESULT=false/);
  assert.ok(dest);
});
