const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startOsvStub } = require("./helpers/osv-stub");
const { RUNNERS, OTHERS } = require("./helpers/runner-cases");

const ASSETS = path.join(__dirname, "..", "assets");
const SHARED = path.join(ASSETS, "_safe_pkg_shared.sh");
const { parseSpec, npmViewCommand } = require(path.join(ASSETS, "malware-scan.js"));

const zshAvailable = spawnSync("zsh", ["--version"], { stdio: "pipe" }).status === 0;
const SHELLS = [["bash"], ...(zshAvailable ? [["zsh"]] : [])];

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

test("on Windows npm view runs npm-cli.js with node instead of npm.cmd", () => {
  const args = ["view", "--json", "--", "foo@1 & calc", "version"];
  assert.deepEqual(npmViewCommand("foo@1 & calc", { platform: "linux" }), { file: "npm", args });
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const seen = [];
  const exists = (p) => {
    seen.push(p);
    return true;
  };
  assert.deepEqual(npmViewCommand("foo@1 & calc", { platform: "win32", execPath, exists }), {
    file: execPath,
    args: [cli, ...args],
  });
  assert.deepEqual(seen, [cli]);
  assert.throws(
    () => npmViewCommand("foo", { platform: "win32", execPath, exists: () => false }),
    /could not look up foo: npm not found at C:\\Program Files\\nodejs\\node_modules/,
  );
});

test("npm view gets a spec starting with - after --, never as an option", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  for (const opts of [{ platform: "linux" }, { platform: "win32", execPath, exists: () => true }]) {
    const { args } = npmViewCommand("--registry=http://evil", opts);
    const end = args.indexOf("--");
    assert.ok(end > 0, opts.platform);
    assert.ok(args.indexOf("--json") < end, opts.platform);
    assert.deepEqual(args.slice(end + 1), ["--registry=http://evil", "version"], opts.platform);
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
if [ "$1" = prefix ]; then echo "$NPM_PREFIX"; exit 0; fi
if [ "$1" = view ]; then
  case "$4" in
    unknown-*) echo "npm error code E404" >&2; exit 1 ;;
    broken-*) echo "npm error code ECONNRESET" >&2; exit 1 ;;
    *) echo '"1.2.3"'; exit 0 ;;
  esac
fi
`,
    { mode: 0o755 },
  );
  for (const name of ["npx", "pnpx", "pnpm", "yarn"]) {
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
function run(wrapper, line, extraEnv = {}, shell = "bash") {
  fs.writeFileSync(log, "");
  const r = spawnSync(shell, ["-c", `source "$HOME/.safe-pnpm/${wrapper}"; ${line}`], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: root,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.readFileSync(log, "utf8") };
}

test("npx of a clean package checks it, then runs it", () => {
  const r = run("npm-wrapper.sh", "npx cowsay@latest hi");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 package checked against OSV; none known malicious/);
  assert.match(r.calls, /npm view --json -- cowsay@latest version/);
  assert.match(r.calls, /RAN npx cowsay@latest hi/);
});

test("pnpx is checked like pnpm dlx before it runs", () => {
  const bad = run("pnpm-wrapper.sh", "pnpx mal-pkg");
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.doesNotMatch(bad.calls, /RAN/);
  const ok = run("pnpm-wrapper.sh", "pnpx cowsay@^1 hi");
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.calls, /npm view --json -- cowsay@\^1 version/);
  assert.match(ok.calls, /RAN pnpx cowsay@\^1 hi/);
});

// On a disk that ignores case (macOS by default) the shell finds the real
// program under any spelling of its name, so every spelling must reach the
// wrapper. Where the disk is case-sensitive the program would not be found.
test("any spelling of a wrapped name runs the wrapper", () => {
  for (const [wrapper, line] of [
    ["npm-wrapper.sh", "NPX mal-pkg"],
    ["npm-wrapper.sh", "Npm exec mal-pkg"],
    ["pnpm-wrapper.sh", "PNPM dlx mal-pkg"],
    ["pnpm-wrapper.sh", "pnpX mal-pkg"],
    ["yarn-wrapper.sh", "Yarn dlx mal-pkg"],
  ]) {
    for (const shell of ["bash", "zsh"]) {
      if (shell === "zsh" && !zshAvailable) continue;
      const r = run(wrapper, line, {}, shell);
      assert.equal(r.status, 1, `${shell}: ${line}\n${r.out}`);
      assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/, `${shell}: ${line}`);
      assert.doesNotMatch(r.calls, /RAN/, `${shell}: ${line}`);
    }
  }
  const ok = run("npm-wrapper.sh", "NPM run build");
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.calls, /^npm run build$/m);
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
  const ok = run("pnpm-wrapper.sh", "pnpm dlx cowsay@latest");
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.calls, /RAN pnpm dlx cowsay@latest/);
});

test("create commands check the create- package the manager would fetch", () => {
  const r = run("pnpm-wrapper.sh", "pnpm create vite app");
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /npm view --json -- create-vite version/);
  assert.match(r.calls, /RAN pnpm create vite app/);
  const n = run("npm-wrapper.sh", "npm exec mal-pkg");
  assert.equal(n.status, 1, n.out);
});

test("a package the registry does not have is noted and the command still runs", () => {
  const r = run("npm-wrapper.sh", "npx unknown-pkg@latest");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /0 packages checked.*1 not checked/);
  assert.match(r.calls, /RAN npx unknown-pkg@latest/);
});

test("a local path is not sent to npm view or OSV", () => {
  const r = run("npm-wrapper.sh", "npx ./local-tool");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /npm view/);
  assert.match(r.calls, /RAN npx \.\/local-tool/);
});

test("an unreachable OSV warns and runs; strict mode blocks", () => {
  const dead = { SAFE_PNPM_OSV_API: "http://127.0.0.1:1" };
  const warn = run("npm-wrapper.sh", "npx cowsay@latest", dead);
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /could not reach OSV.*Continuing without it/s);
  assert.match(warn.calls, /RAN npx cowsay@latest/);
  const strict = run("npm-wrapper.sh", "npx cowsay@latest", { ...dead, SAFE_PNPM_OSV_STRICT: "1" });
  assert.equal(strict.status, 1, strict.out);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("a failed version lookup counts as a scan failure, not a pass", () => {
  const warn = run("npm-wrapper.sh", "npx broken-pkg@latest");
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /could not look up broken-pkg/);
  const strict = run("npm-wrapper.sh", "npx broken-pkg@latest", { SAFE_PNPM_OSV_STRICT: "1" });
  assert.equal(strict.status, 1, strict.out);
  assert.doesNotMatch(strict.calls, /RAN/);
});

test("commands that run no downloaded package skip the check", () => {
  const r = run("npm-wrapper.sh", "npm run build");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /npm view/);
});

// Issue 100: with no version, npx of a command that is not installed would
// download whatever the registry has under that name, which may be a
// placeholder OSV knows nothing about (npx tsc fetches tsc, not TypeScript).
const UNPINNED = /cowsay names no version and would be downloaded/;

function withFile(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  try {
    return fn();
  } finally {
    fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "global"), { recursive: true, force: true });
  }
}

test("npx, npm exec, pnpm dlx and yarn dlx with no version are refused when not installed", () => {
  for (const [wrapper, line] of [
    ["npm-wrapper.sh", "npx cowsay hi"],
    ["npm-wrapper.sh", "npm exec cowsay"],
    ["npm-wrapper.sh", "npx --package cowsay say"],
    ["pnpm-wrapper.sh", "pnpm dlx cowsay"],
    ["pnpm-wrapper.sh", "pnpx cowsay"],
    ["yarn-wrapper.sh", "yarn dlx cowsay"],
  ]) {
    const r = run(wrapper, line);
    assert.equal(r.status, 1, `${line}\n${r.out}`);
    assert.match(r.out, UNPINNED, line);
    assert.match(r.out, /cowsay@1\.2\.3, or @latest/, line);
    assert.match(r.out, /no package code was executed/, line);
    assert.doesNotMatch(r.calls, /RAN/, line);
  }
});

test("a malicious unpinned package is reported as malware, not as unpinned", () => {
  const r = run("npm-wrapper.sh", "npx mal-pkg");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.doesNotMatch(r.out, /names no version/);
});

test("the unpinned refusal holds when OSV cannot be reached", () => {
  const r = run("npm-wrapper.sh", "npx cowsay", { SAFE_PNPM_OSV_API: "http://127.0.0.1:1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not reach OSV/);
  assert.match(r.out, UNPINNED);
  assert.doesNotMatch(r.calls, /RAN/);
});

test("npx with no version runs a command installed in the project, a parent or globally", () => {
  for (const file of [
    path.join(root, "node_modules", ".bin", "cowsay"),
    path.join(root, "node_modules", "cowsay", "package.json"),
  ]) {
    withFile(file, () => {
      const r = run("npm-wrapper.sh", "npx cowsay hi");
      assert.equal(r.status, 0, `${file}\n${r.out}`);
      assert.match(r.calls, /RAN npx cowsay hi/, file);
    });
  }
  const sub = path.join(root, "pkg", "sub");
  fs.mkdirSync(sub, { recursive: true });
  withFile(path.join(root, "node_modules", ".bin", "cowsay"), () => {
    fs.writeFileSync(log, "");
    const r = spawnSync("bash", ["-c", 'source "$HOME/.safe-pnpm/npm-wrapper.sh"; npx cowsay'], {
      encoding: "utf8",
      env,
      cwd: sub,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });
  const prefix = path.join(root, "global");
  for (const file of [path.join(prefix, "bin", "cowsay"), path.join(prefix, "lib", "node_modules", "cowsay", "package.json")]) {
    withFile(file, () => {
      const r = run("npm-wrapper.sh", "npx cowsay", { NPM_PREFIX: prefix });
      assert.equal(r.status, 0, `${file}\n${r.out}`);
      assert.match(r.calls, /npm prefix -g/);
    });
  }
});

test("--package with no version is refused unless that package is installed", () => {
  const bad = run("npm-wrapper.sh", "npx --package cowsay say");
  assert.equal(bad.status, 1, bad.out);
  withFile(path.join(root, "node_modules", "cowsay", "package.json"), () => {
    const ok = run("npm-wrapper.sh", "npx --package cowsay say");
    assert.equal(ok.status, 0, ok.out);
  });
  const pinned = run("npm-wrapper.sh", "npx --package cowsay@1.5.0 say");
  assert.equal(pinned.status, 0, pinned.out);
});

test("pnpm dlx and yarn dlx always download, so an installed copy does not count", () => {
  withFile(path.join(root, "node_modules", ".bin", "cowsay"), () => {
    for (const [wrapper, line] of [
      ["pnpm-wrapper.sh", "pnpm dlx cowsay"],
      ["yarn-wrapper.sh", "yarn dlx cowsay"],
    ]) {
      const r = run(wrapper, line);
      assert.equal(r.status, 1, `${line}\n${r.out}`);
      assert.match(r.out, UNPINNED, line);
    }
  });
});

test("create commands and paths are not refused for having no version", () => {
  for (const [wrapper, line] of [
    ["npm-wrapper.sh", "npm create vite"],
    ["pnpm-wrapper.sh", "pnpm create vite app"],
    ["npm-wrapper.sh", "npx ./local-tool"],
  ]) {
    const r = run(wrapper, line);
    assert.equal(r.status, 0, `${line}\n${r.out}`);
    assert.doesNotMatch(r.out, /names no version/, line);
  }
});
