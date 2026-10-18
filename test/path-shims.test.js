const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startOsvStub } = require("./helpers/osv-stub");

const ASSETS = path.join(__dirname, "..", "assets");
const BIN = path.join(__dirname, "..", "bin", "safe-pnpm.js");
const NODE_DIR = path.dirname(process.execPath);
const NAMES = ["pnpm", "pnpx", "npm", "npx", "yarn"];
// Every run gets a timeout: a shim that finds itself would loop forever.
const TIMEOUT = 30000;

// A throwaway HOME with the wrappers and the shims installed, and a "real"
// bin directory after the shim directory on PATH. The real stubs log their
// argv one per line, print STUB OUT on stdout and exit with $STUB_EXIT. The
// stub npm also answers `npm view`, which the scanner runs by name, so that
// lookup goes through the npm shim as well.
let osv;
let root;
let home;
let shims;
let real;
let log;
let env;
before(async () => {
  osv = await startOsvStub();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-shims-"));
  home = path.join(root, "home");
  shims = path.join(home, ".safe-pnpm", "bin");
  real = path.join(root, "real");
  log = path.join(root, "calls.log");
  fs.mkdirSync(shims, { recursive: true });
  fs.mkdirSync(real);
  for (const f of ["_safe_pkg_shared.sh", "pnpm-wrapper.sh", "npm-wrapper.sh", "yarn-wrapper.sh", "malware-scan.js"]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(home, ".safe-pnpm", f));
  }
  fs.writeFileSync(
    path.join(home, ".safe-pnpm", "config.json"),
    JSON.stringify({ enabledManagers: ["pnpm", "npm", "yarn"] }),
  );
  for (const name of NAMES) {
    fs.copyFileSync(path.join(ASSETS, "path-shim.sh"), path.join(shims, name));
    fs.chmodSync(path.join(shims, name), 0o755);
    fs.writeFileSync(
      path.join(real, name),
      `#!/bin/sh
if [ "${name}" = npm ] && [ "$1" = view ]; then echo '"1.2.3"'; exit 0; fi
{ echo "RAN ${name}"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "${log}"
if [ "${name}" = pnpm ] && [ "$1" = run ] && [ "$2" = nested ]; then
  pnpm install --global left-pad
  exit $?
fi
echo "STUB OUT"
exit "\${STUB_EXIT:-0}"
`,
      { mode: 0o755 },
    );
  }
  env = {
    ...process.env,
    HOME: home,
    PATH: [shims, real, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter),
    SAFE_PNPM_OSV_API: `${osv.url}/ok`,
  };
  delete env.SAFE_PNPM_OSV_STRICT;
  delete env.SAFE_PNPM_STRICT;
  delete env.STUB_EXIT;
  delete env._SAFE_PKG_SHIM_DEPTH;
});
after(() => {
  osv.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function run(file, args, extraEnv = {}) {
  fs.writeFileSync(log, "");
  const r = spawnSync(file, args, {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: root,
    timeout: TIMEOUT,
  });
  assert.equal(r.error, undefined, `${file} ${args.join(" ")}: ${r.error}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.readFileSync(log, "utf8") };
}

test("pnpm dlx of a malicious package through the shim is blocked, with stdout untouched", () => {
  const r = run("pnpm", ["dlx", "mal-pkg@1"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.match(r.stderr, /no package code was executed/);
  assert.equal(r.stdout, "");
  assert.equal(r.calls, "");
});

test("every shim name runs its wrapper's check", () => {
  for (const [name, args] of [
    ["pnpx", ["mal-pkg"]],
    ["npx", ["mal-pkg"]],
    ["npm", ["exec", "mal-pkg"]],
    ["yarn", ["dlx", "mal-pkg"]],
  ]) {
    const r = run(name, args);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /MAL-2099-1/, name);
    assert.equal(r.calls, "", name);
  }
});

test("a clean dlx reaches the real binary and only its output is on stdout", () => {
  const r = run("pnpm", ["dlx", "cowsay"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "STUB OUT\n");
  assert.match(r.stderr, /none known malicious/);
  assert.equal(r.calls, "RAN pnpm\ndlx\ncowsay\n");
});

test("an allowed command passes argv through unchanged and keeps the exit code", () => {
  const args = ["run", "build", "a b", "", "--flag=$HOME", "*", "--"];
  for (const code of ["0", "7"]) {
    const r = run("pnpm", args, { STUB_EXIT: code });
    assert.equal(r.status, Number(code), r.stderr);
    assert.equal(r.calls, `RAN pnpm\n${args.join("\n")}\n`);
  }
  const y = run("yarn", ["run", "x y"], { STUB_EXIT: "3" });
  assert.equal(y.status, 3, y.stderr);
  assert.equal(y.calls, "RAN yarn\nrun\nx y\n");
});

test("with no real binary after the shims, the shim fails closed instead of looping", () => {
  const tools = path.join(root, "tools");
  fs.mkdirSync(tools, { recursive: true });
  for (const t of ["bash", "dirname", "basename", "tr"]) {
    const found = ["/bin", "/usr/bin"].map((d) => path.join(d, t)).find((f) => fs.existsSync(f));
    if (!fs.existsSync(path.join(tools, t))) fs.symlinkSync(found, path.join(tools, t));
  }
  // The shim directory twice, as a real PATH sometimes has it, plus a
  // relative entry that must not be used.
  const r = run(path.join(shims, "pnpm"), ["run", "build"], {
    PATH: [shims, ".", shims, tools].join(path.delimiter),
  });
  assert.equal(r.status, 127, r.stderr);
  assert.match(r.stderr, /no pnpm found on PATH apart from the shims/);
  assert.equal(r.calls, "");
});

test("with wrappers older than the shims, the shim refuses instead of finding itself", () => {
  // A pre-shim wrapper passes commands on with `command pnpm`, which would
  // find the shim again.
  const old = path.join(root, "old-home");
  const oldShims = path.join(old, ".safe-pnpm", "bin");
  fs.mkdirSync(oldShims, { recursive: true });
  fs.writeFileSync(path.join(old, ".safe-pnpm", "_safe_pkg_shared.sh"), "");
  fs.writeFileSync(path.join(old, ".safe-pnpm", "pnpm-wrapper.sh"), 'pnpm() { command pnpm "$@"; }\n');
  fs.copyFileSync(path.join(ASSETS, "path-shim.sh"), path.join(oldShims, "pnpm"));
  fs.chmodSync(path.join(oldShims, "pnpm"), 0o755);
  const r = run("pnpm", ["run", "build"], {
    HOME: old,
    PATH: [oldShims, real, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /older than the PATH shims/);
  assert.equal(r.calls, "");
});

test("a chain that re-enters the shim too often is stopped", () => {
  const r = run("pnpm", ["run", "build"], { _SAFE_PKG_SHIM_DEPTH: "32" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /entered 33 times in a row/);
  assert.equal(r.calls, "");
});

test("with the shims on PATH, a refusal names the real binary instead of `command npm`", () => {
  const r = run("npm", ["update", "-g", "@jboho/safe-pnpm"]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`run: ${path.join(real, "npm")} update -g @jboho/safe-pnpm`), r.stderr);
  const off = run("bash", ["-c", `source "${path.join(home, ".safe-pnpm", "_safe_pkg_shared.sh")}"; source "${path.join(home, ".safe-pnpm", "npm-wrapper.sh")}"; npm update -g x`], {
    PATH: [real, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter),
  });
  assert.equal(off.status, 1, off.stderr);
  assert.match(off.stderr, /run: command npm update -g x/);
});

test("child_process.spawn('pnpm') from a node program hits the shim", () => {
  const script = "const r = require('node:child_process').spawnSync('pnpm', ['dlx', 'mal-pkg'], { stdio: 'inherit' }); process.exit(r.status);";
  const r = run(process.execPath, ["-e", script]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MAL-2099-1/);
  assert.equal(r.calls, "");
});

test("a pnpm install started by a package script is intercepted again", () => {
  const r = run("pnpm", ["run", "nested"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.calls, /^RAN pnpm\nrun\nnested\n$/);
  assert.match(r.stderr, /global installs are not supported through the wrapper/);
});

test("safe-pnpm exec -- puts the shims on PATH for the whole process tree and keeps the exit code", () => {
  const offPath = { PATH: [real, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter) };
  const ok = run(process.execPath, [BIN, "exec", "--", "sh", "-c", 'pnpm run build "a b"'], {
    ...offPath,
    STUB_EXIT: "5",
  });
  assert.equal(ok.status, 5, ok.stderr);
  assert.equal(ok.calls, "RAN pnpm\nrun\nbuild\na b\n");
  const bad = run(process.execPath, [BIN, "exec", "--", "sh", "-c", 'sh -c "pnpm dlx mal-pkg"'], offPath);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /MAL-2099-1/);
  assert.equal(bad.calls, "");
  // Without the shims, the same command reaches the real binary unchecked.
  const bare = run("sh", ["-c", "pnpm dlx mal-pkg"], offPath);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.calls, /RAN pnpm/);
});

test("safe-pnpm exec refuses to run when the shims are missing", () => {
  const empty = path.join(root, "empty-home");
  fs.mkdirSync(empty, { recursive: true });
  const r = run(process.execPath, [BIN, "exec", "--", "true"], { HOME: empty });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /shims missing/);
  const usage = run(process.execPath, [BIN, "exec", "--"]);
  assert.equal(usage.status, 2);
});

test("setup --path-shims adds the PATH line once, moves it behind later PATH changes, and --remove-path-shims undoes it", () => {
  const rc = path.join(home, ".zshrc");
  const before = "export FOO=1\n# safe-pnpm\nsource \"$HOME/.safe-pnpm/pnpm-wrapper.sh\"\n";
  fs.writeFileSync(rc, before);
  const setupEnv = { SHELL: "/bin/zsh" };
  const line = 'export PATH="$HOME/.safe-pnpm/bin:$PATH"';

  const first = run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
  assert.equal(first.status, 0, first.stderr);
  let content = fs.readFileSync(rc, "utf8");
  assert.ok(content.startsWith(before), content);
  assert.ok(content.endsWith(`# PATH shims (safe-pnpm)\n${line}\n`), content);

  const again = run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(rc, "utf8"), content);

  fs.appendFileSync(rc, 'export PNPM_HOME="$HOME/Library/pnpm"\n');
  const moved = run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
  assert.equal(moved.status, 0, moved.stderr);
  content = fs.readFileSync(rc, "utf8");
  assert.equal(content.split(line).length, 2, content);
  assert.ok(content.indexOf("PNPM_HOME") < content.indexOf(line), content);

  fs.appendFileSync(rc, 'eval "$(/opt/homebrew/bin/brew shellenv)"\n');
  const brew = run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
  assert.equal(brew.status, 0, brew.stderr);
  content = fs.readFileSync(rc, "utf8");
  assert.ok(content.indexOf("shellenv") < content.indexOf(line), content);

  const removed = run(process.execPath, [BIN, "setup", "--remove-path-shims"], setupEnv);
  assert.equal(removed.status, 0, removed.stderr);
  content = fs.readFileSync(rc, "utf8");
  assert.equal(
    content,
    `${before}export PNPM_HOME="$HOME/Library/pnpm"\neval "$(/opt/homebrew/bin/brew shellenv)"\n`,
  );
  // Add and remove leave the file as it was, without a stray blank line.
  run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
  run(process.execPath, [BIN, "setup", "--remove-path-shims"], setupEnv);
  assert.equal(fs.readFileSync(rc, "utf8"), content);

  // Wrapper files from an older release: refuse, so the shims never run
  // next to wrappers that would hand the command back to them.
  const shared = path.join(home, ".safe-pnpm", "_safe_pkg_shared.sh");
  const saved = fs.readFileSync(shared);
  fs.writeFileSync(shared, "# an older release\n");
  try {
    const stale = run(process.execPath, [BIN, "setup", "--path-shims"], setupEnv);
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /differ from this package \(_safe_pkg_shared\.sh\).*Run safe-pnpm update first/s);
    assert.equal(fs.readFileSync(rc, "utf8"), content);
  } finally {
    fs.writeFileSync(shared, saved);
  }

  const bad = run(process.execPath, [BIN, "setup", "--bogus"], setupEnv);
  assert.equal(bad.status, 1);
});

test("doctor reports the shims, whether they come first, and every binary on PATH in order", () => {
  const first = run(process.execPath, [BIN, "doctor"]);
  assert.match(first.stdout, /PATH shims\s+.*pnpm, pnpx, npm, npx, yarn/);
  for (const name of NAMES) {
    assert.match(first.stdout, new RegExp(`${name} on PATH\\s+shim comes first`));
    assert.ok(first.stdout.includes(`${path.join(shims, name)} (shim)`), name);
    assert.ok(first.stdout.indexOf(path.join(shims, name)) < first.stdout.indexOf(path.join(real, name)), name);
  }
  const behind = run(process.execPath, [BIN, "doctor"], {
    PATH: [real, shims, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter),
  });
  assert.match(behind.stdout, new RegExp(`pnpm on PATH\\s+.*${path.join(real, "pnpm")} comes before the shim`));
  const off = run(process.execPath, [BIN, "doctor"], {
    PATH: [real, NODE_DIR, "/usr/bin", "/bin"].join(path.delimiter),
  });
  assert.match(off.stdout, /Shims on PATH\s+.*not on PATH/);
});
