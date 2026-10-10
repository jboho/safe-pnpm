const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startOsvStub } = require("./helpers/osv-stub");

const ASSETS = path.join(__dirname, "..", "assets");
const SHARED = path.join(ASSETS, "_safe_pkg_shared.sh");
const { parseSpec } = require(path.join(ASSETS, "malware-scan.js"));

const zshAvailable = spawnSync("zsh", ["--version"], { stdio: "pipe" }).status === 0;
const SHELLS = [["bash"], ...(zshAvailable ? [["zsh"]] : [])];

// Commands that fetch a package and run it, and the specs the finder reports.
const RUNNERS = [
  ["npx", ["cowsay", "hi"], ["cowsay"]],
  ["npx", ["-y", "cowsay@1.5.0"], ["cowsay@1.5.0"]],
  ["npx", ["-p", "lodash", "-p", "cowsay", "cowsay"], ["lodash", "cowsay"]],
  ["npx", ["--package=foo", "bar"], ["foo"]],
  ["npx", ["--registry", "http://r", "cowsay"], ["cowsay"]],
  // an unlisted flag may take a value, so the next word is checked too
  ["npx", ["--future-flag", "val", "cowsay"], ["val", "cowsay"]],
  ["npx", ["--", "cowsay"], ["cowsay"]],
  ["npm", ["exec", "cowsay"], ["cowsay"]],
  ["npm", ["--prefix", "web", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["x", "--", "cowsay"], ["cowsay"]],
  ["npm", ["init", "vite"], ["create-vite"]],
  ["npm", ["create", "@scope/foo"], ["@scope/create-foo"]],
  ["npm", ["create", "@scope"], ["@scope/create"]],
  ["npm", ["create", "@scope@2"], ["@scope/create@2"]],
  // already prefixed: npm adds create- again, pnpm and yarn do not
  ["npm", ["init", "create-foo"], ["create-create-foo", "create-foo"]],
  ["pnpm", ["dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["-C", "web", "dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["create", "vite@latest", "app"], ["create-vite@latest"]],
  ["yarn", ["dlx", "cowsay"], ["cowsay"]],
  ["yarn", ["create", "react-app", "app"], ["create-react-app"]],
];

// Not download-and-run: the finder must report nothing and return 1.
const OTHERS = [
  ["npm", ["install", "x"]],
  ["npm", ["run", "build"]],
  ["npm", ["--version"]],
  ["pnpm", ["exec", "cowsay"]],
  ["pnpm", ["add", "x"]],
  ["yarn", ["add", "x"]],
  ["yarn", []],
];

for (const [shell] of SHELLS) {
  test(`${shell}: _safe_pkg_runner_specs finds the packages a runner command fetches`, () => {
    for (const [manager, args, want] of RUNNERS) {
      const r = spawnSync(
        shell,
        ["-c", 'source "$1"; shift; _safe_pkg_runner_specs "$@"', "sh", SHARED, manager, ...args],
        { encoding: "utf8" },
      );
      const label = `${manager} ${args.join(" ")}`;
      assert.equal(r.status, 0, label);
      assert.deepEqual(r.stdout.split("\n").filter(Boolean), want, label);
    }
  });

  test(`${shell}: _safe_pkg_runner_specs returns 1 for commands that fetch nothing to run`, () => {
    for (const [manager, args] of OTHERS) {
      const r = spawnSync(
        shell,
        ["-c", 'source "$1"; shift; _safe_pkg_runner_specs "$@"', "sh", SHARED, manager, ...args],
        { encoding: "utf8" },
      );
      const label = `${manager} ${args.join(" ")}`;
      assert.equal(r.status, 1, label);
      assert.equal(r.stdout, "", label);
    }
  });
}

test("parseSpec keeps registry specs and drops paths, urls, git and aliases", () => {
  assert.deepEqual(parseSpec("cowsay"), { name: "cowsay", range: "" });
  assert.deepEqual(parseSpec("cowsay@^1"), { name: "cowsay", range: "^1" });
  assert.deepEqual(parseSpec("@a/b@latest"), { name: "@a/b", range: "latest" });
  for (const spec of [
    "./local",
    "../x",
    "/abs/path",
    "~/x",
    "user/repo",
    "https://example.com/x.tgz",
    "git+ssh://git@github.com/a/b.git",
    "github:a/b",
    "file:../x",
    "npm:other@1",
  ]) {
    assert.equal(parseSpec(spec), null, spec);
  }
});

// End to end: the wrappers sourced in a throwaway HOME, the real scanner, the
// OSV stub, and stub `npm`, `npx`, `pnpm` and `yarn` binaries on PATH. The
// stub npm answers `npm view` (what the scanner resolves versions with) and
// logs every call; the other stubs log that they ran.
let osv;
let root;
let env;
let log;
before(async () => {
  osv = await startOsvStub();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-runner-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(home, ".safe-pnpm"), { recursive: true });
  fs.mkdirSync(bin);
  for (const f of ["_safe_pkg_shared.sh", "pnpm-wrapper.sh", "npm-wrapper.sh", "yarn-wrapper.sh", "malware-scan.js"]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(home, ".safe-pnpm", f));
  }
  log = path.join(root, "calls.log");
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh
echo "npm $*" >> "${log}"
if [ "$1" = view ]; then
  case "$2" in
    unknown-*) echo "npm error code E404" >&2; exit 1 ;;
    broken-*) echo "npm error code ECONNRESET" >&2; exit 1 ;;
    *) echo '"1.2.3"'; exit 0 ;;
  esac
fi
`,
    { mode: 0o755 },
  );
  for (const name of ["npx", "pnpm", "yarn"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "RAN ${name} $*" >> "${log}"\n`, { mode: 0o755 });
  }
  env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SAFE_PNPM_OSV_API: `${osv.url}/ok`,
  };
  delete env.SAFE_PNPM_OSV_STRICT;
  delete env.SAFE_PNPM_STRICT;
});
after(() => {
  osv.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

// Runs `wrapper` then the command line in bash and reports exit, output and
// the stub log.
function run(wrapper, line, extraEnv = {}) {
  fs.writeFileSync(log, "");
  const r = spawnSync("bash", ["-c", `source "$HOME/.safe-pnpm/${wrapper}"; ${line}`], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: root,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.readFileSync(log, "utf8") };
}

test("npx of a clean package checks it, then runs it", () => {
  const r = run("npm-wrapper.sh", "npx cowsay hi");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 package checked against OSV; none known malicious/);
  assert.match(r.calls, /npm view cowsay version --json/);
  assert.match(r.calls, /RAN npx cowsay hi/);
});

test("npx of a known-malicious package is blocked and never runs", () => {
  const r = run("npm-wrapper.sh", "npx mal-pkg");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.match(r.out, /no package code was executed/);
  assert.doesNotMatch(r.calls, /RAN/);
});

test("a malicious package passed with -p is blocked even when the command word is clean", () => {
  const r = run("npm-wrapper.sh", "npx -p mal-pkg cowsay");
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.calls, /RAN/);
});

test("pnpm dlx and yarn dlx are checked before they run", () => {
  const p = run("pnpm-wrapper.sh", "pnpm dlx mal-pkg");
  assert.equal(p.status, 1, p.out);
  assert.doesNotMatch(p.calls, /RAN/);
  const y = run("yarn-wrapper.sh", "yarn dlx mal-pkg");
  assert.equal(y.status, 1, y.out);
  assert.doesNotMatch(y.calls, /RAN/);
  const ok = run("pnpm-wrapper.sh", "pnpm dlx cowsay");
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.calls, /RAN pnpm dlx cowsay/);
});

test("create commands check the create- package the manager would fetch", () => {
  const r = run("pnpm-wrapper.sh", "pnpm create vite app");
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /npm view create-vite version --json/);
  assert.match(r.calls, /RAN pnpm create vite app/);
  const n = run("npm-wrapper.sh", "npm exec mal-pkg");
  assert.equal(n.status, 1, n.out);
});

test("a package the registry does not have is noted and the command still runs", () => {
  const r = run("npm-wrapper.sh", "npx unknown-pkg");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /0 packages checked.*1 not checked/);
  assert.match(r.calls, /RAN npx unknown-pkg/);
});

test("a local path is not sent to npm view or OSV", () => {
  const r = run("npm-wrapper.sh", "npx ./local-tool");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /npm view/);
  assert.match(r.calls, /RAN npx \.\/local-tool/);
});

test("an unreachable OSV warns and runs; strict mode blocks", () => {
  const dead = { SAFE_PNPM_OSV_API: "http://127.0.0.1:1" };
  const warn = run("npm-wrapper.sh", "npx cowsay", dead);
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /could not reach OSV.*Continuing without it/s);
  assert.match(warn.calls, /RAN npx cowsay/);
  const strict = run("npm-wrapper.sh", "npx cowsay", { ...dead, SAFE_PNPM_OSV_STRICT: "1" });
  assert.equal(strict.status, 1, strict.out);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("a failed version lookup counts as a scan failure, not a pass", () => {
  const warn = run("npm-wrapper.sh", "npx broken-pkg");
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /could not look up broken-pkg/);
  const strict = run("npm-wrapper.sh", "npx broken-pkg", { SAFE_PNPM_OSV_STRICT: "1" });
  assert.equal(strict.status, 1, strict.out);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("commands that run no downloaded package skip the check", () => {
  const r = run("npm-wrapper.sh", "npm run build");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /npm view/);
});
