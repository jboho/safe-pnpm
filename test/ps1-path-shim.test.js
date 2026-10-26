// The Windows PATH shim (path-shim.ps1) run in a Linux pwsh container. On
// Windows NAME.cmd starts `pwsh -File path-shim.ps1 NAME %*`; here an
// executable sh file in the shim directory does the same with "$@", so the
// shim runs as its own process and is found on PATH by spawn, sh and pwsh
// like NAME.cmd is. The NAME.ps1 shims and installShims' files are the real
// ones. windows-cmd-shims.test.js runs the .cmd files on Windows.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMAGE, hasDocker, buildPwshImage } = require("./helpers/pwsh-image");

const ASSETS = path.join(__dirname, "..", "assets");
const skip = hasDocker ? false : "docker not available";
const NAMES = ["pnpm", "pnpx", "npm", "npx", "yarn"];

// shims.js reads the home directory when it loads; point it at the
// container's home, mounted at /w/home.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ps1shim-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
const { installShims } = require("../lib/util/shims");

// Each case runs one command in the container, from a node driver, with
// PATH = shims, the real stubs, then the system. The real stubs log their
// argv one per line to /w/calls/<case>, print STUB OUT and exit with
// $STUB_EXIT; npm also answers `npm view`, `pnpm run nested` runs
// `pnpm dlx mal-pkg` again by name, and `pnpm run echo` copies stdin to stdout.
const SYS = "/usr/local/bin:/usr/bin:/bin";
const PATH_ON = `/w/home/.safe-pnpm/bin:/w/real:${SYS}`;
const CASES = {};
const add = (label, argv, env = {}, input = undefined) => {
  CASES[label] = { argv, env, input };
};
const ARGS = [
  "run",
  "build",
  "a b",
  "",
  "--flag=$HOME",
  "*",
  "--",
  'q"q',
  "-Command",
  "%PATH%",
];
add("dlx mal", ["pnpm", "dlx", "mal-pkg@1"]);
add("pnpx mal", ["pnpx", "mal-pkg"]);
add("npx mal", ["npx", "mal-pkg"]);
add("npm exec mal", ["npm", "exec", "mal-pkg"]);
add("yarn dlx mal", ["yarn", "dlx", "mal-pkg"]);
add("dlx clean", ["pnpm", "dlx", "cowsay@latest"]);
add("argv 0", ["pnpm", ...ARGS]);
add("argv 7", ["pnpm", ...ARGS], { STUB_EXIT: "7" });
add("yarn exit 3", ["yarn", "run", "x y"], { STUB_EXIT: "3" });
add("nested", ["pnpm", "run", "nested"]);
add("depth", ["pnpm", "run", "build"], { _SAFE_PKG_SHIM_DEPTH: "32" });
add("no real", ["/w/home/.safe-pnpm/bin/pnpm", "run", "build"], {
  PATH: `/w/home/.safe-pnpm/bin:/w/home/.safe-pnpm/bin:${SYS}`,
});
add("old wrappers", ["pnpm", "run", "build"], { HOME: "/w/old" });
add("bypass hint", ["npm", "update", "-g", "@jboho/safe-pnpm"]);
add("node spawn", [
  "node",
  "-e",
  "const r = require('node:child_process').spawnSync('pnpm', ['dlx', 'mal-pkg'], { stdio: 'inherit' }); process.exit(r.status);",
]);
add(
  "stdin",
  ["pnpm", "run", "echo"],
  {},
  '{"jsonrpc":"2.0","id":1}\né\r\nno newline',
);
// A PowerShell session without the profile finds NAME.ps1.
const ps1 = (line) => [
  "pwsh",
  "-NoProfile",
  "-Command",
  `${line}; exit $LASTEXITCODE`,
];
add(
  "ps1 argv",
  ps1("& /w/home/.safe-pnpm/bin/pnpm.ps1 run build 'a b' '' 'q\"q'"),
  { STUB_EXIT: "4" },
);
add("ps1 mal", ps1("& /w/home/.safe-pnpm/bin/npx.ps1 mal-pkg"));

const DRIVER = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { startOsvStub } = require("/w/osv-stub.js");
const cases = require("/w/cases.json");
(async () => {
  const osv = await startOsvStub();
  const out = {};
  for (const [label, { argv, env, input }] of Object.entries(cases)) {
    const calls = "/w/calls/" + Object.keys(out).length;
    fs.writeFileSync(calls, "");
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      input,
      cwd: "/w/proj",
      timeout: 180000,
      env: {
        HOME: "/w/home",
        PATH: ${JSON.stringify(PATH_ON)},
        SAFE_PNPM_OSV_API: osv.url + "/ok",
        STUB_LOG: calls,
        ...env,
      },
    });
    out[label] = { status: r.status, error: r.error && String(r.error), stdout: r.stdout, stderr: r.stderr, calls: fs.readFileSync(calls, "utf8") };
  }
  osv.stop();
  fs.writeFileSync("/w/results.json", JSON.stringify(out));
})();
`;

const STUB = (name) => `#!/bin/sh
if [ "${name}" = npm ] && [ "$1" = view ]; then echo '"1.2.3"'; exit 0; fi
if [ "${name}" = npm ] && [ "$1" = prefix ]; then exit 0; fi
{ echo "RAN ${name}"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
if [ "${name}" = pnpm ] && [ "$1" = run ] && [ "$2" = nested ]; then
  pnpm dlx mal-pkg
  exit $?
fi
if [ "${name}" = pnpm ] && [ "$1" = run ] && [ "$2" = echo ]; then
  exec cat
fi
echo "STUB OUT"
exit "\${STUB_EXIT:-0}"
`;

let results;
before(() => {
  if (!hasDocker) return;
  buildPwshImage();
  const safe = path.join(home, ".safe-pnpm");
  fs.mkdirSync(safe, { recursive: true });
  for (const f of [
    "_safe_pkg_shared.ps1",
    "pnpm-wrapper.ps1",
    "npm-wrapper.ps1",
    "yarn-wrapper.ps1",
    "malware-scan.js",
  ]) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(safe, f));
  }
  installShims(["pnpm", "npm", "yarn"], "win32");
  const bin = path.join(safe, "bin");
  for (const name of NAMES) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\nexec pwsh -NoProfile -ExecutionPolicy Bypass -File "$(dirname "$0")/../path-shim.ps1" ${name} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    // Executable, so Get-Command finds NAME.cmd here as it does on Windows.
    fs.chmodSync(path.join(bin, `${name}.cmd`), 0o755);
  }
  const real = path.join(tmp, "real");
  fs.mkdirSync(real);
  for (const name of NAMES)
    fs.writeFileSync(path.join(real, name), STUB(name), { mode: 0o755 });
  // Wrappers from before the shims: no _Safe_Pkg_Native_Exe, and a lookup
  // that finds the shim again.
  const old = path.join(tmp, "old", ".safe-pnpm");
  fs.mkdirSync(old, { recursive: true });
  fs.cpSync(bin, path.join(old, "bin"), { recursive: true });
  fs.copyFileSync(
    path.join(safe, "path-shim.ps1"),
    path.join(old, "path-shim.ps1"),
  );
  fs.writeFileSync(
    path.join(old, "pnpm-wrapper.ps1"),
    "function global:pnpm { & (Get-Command pnpm -CommandType Application | Select-Object -First 1).Source @args }\n",
  );
  for (const d of ["calls", "proj"]) fs.mkdirSync(path.join(tmp, d));
  fs.copyFileSync(
    path.join(__dirname, "helpers", "osv-stub.js"),
    path.join(tmp, "osv-stub.js"),
  );
  fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(CASES));
  fs.writeFileSync(path.join(tmp, "driver.js"), DRIVER);
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-v",
      `${tmp}:/w`,
      IMAGE,
      "node",
      "/w/driver.js",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  results = JSON.parse(fs.readFileSync(path.join(tmp, "results.json"), "utf8"));
  assert.equal(
    Object.keys(results).length,
    Object.keys(CASES).length,
    "every case ran",
  );
});
after(
  () =>
    process.env.KEEP_TMP || fs.rmSync(tmp, { recursive: true, force: true }),
);

const result = (label) => {
  const r = results[label];
  assert.ok(r, `no result for ${label}`);
  assert.equal(r.error, undefined, `${label}: ${r.error}`);
  return r;
};

test("ps1 shim: a malicious dlx is blocked, the stub never runs, and stdout stays empty", {
  skip,
}, () => {
  const r = result("dlx mal");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.match(r.stderr, /no package code was executed/);
  assert.equal(r.stdout, "");
  assert.equal(r.calls, "");
});

test("ps1 shim: every shim name runs its wrapper's check", { skip }, () => {
  for (const label of ["pnpx mal", "npx mal", "npm exec mal", "yarn dlx mal"]) {
    const r = result(label);
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /MAL-2099-1/, label);
    assert.equal(r.stdout, "", label);
    assert.equal(r.calls, "", label);
  }
});

test("ps1 shim: a clean dlx reaches the real binary and only its output is on stdout", {
  skip,
}, () => {
  const r = result("dlx clean");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "STUB OUT\n");
  assert.match(r.stderr, /none known malicious/);
  assert.equal(r.calls, "RAN pnpm\ndlx\ncowsay@latest\n");
});

test("ps1 shim: argv reaches the real binary unchanged and the exit code passes through", {
  skip,
}, () => {
  for (const [label, code] of [
    ["argv 0", 0],
    ["argv 7", 7],
  ]) {
    const r = result(label);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.calls, `RAN pnpm\n${ARGS.join("\n")}\n`, label);
  }
  const y = result("yarn exit 3");
  assert.equal(y.status, 3, y.stderr);
  assert.equal(y.calls, "RAN yarn\nrun\nx y\n");
});

test("ps1 shim: stdin and stdout pass through byte for byte", { skip }, () => {
  const r = result("stdin");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, CASES.stdin.input);
});

test("ps1 shim: a package manager started by the real one is intercepted again", {
  skip,
}, () => {
  const r = result("nested");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.calls, "RAN pnpm\nrun\nnested\n");
  assert.match(r.stderr, /MAL-2099-1/);
});

test("ps1 shim: a chain that re-enters the shim too often is stopped", {
  skip,
}, () => {
  const r = result("depth");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /entered 33 times in a row/);
  assert.equal(r.calls, "");
});

test("ps1 shim: with no real binary after the shims, it fails with 127 instead of looping", {
  skip,
}, () => {
  const r = result("no real");
  assert.equal(r.status, 127, r.stderr);
  assert.match(
    r.stderr,
    /no pnpm found on PATH apart from the safe-pnpm PATH shims/,
  );
  assert.equal(r.calls, "");
});

test("ps1 shim: with wrappers older than the shims, it refuses instead of finding itself", {
  skip,
}, () => {
  const r = result("old wrappers");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /older than the PATH shims/);
  assert.equal(r.calls, "");
});

test("ps1 shim: a refusal names the real binary, since npm.cmd is the shim", {
  skip,
}, () => {
  const r = result("bypass hint");
  assert.equal(r.status, 1, r.stderr);
  assert.ok(
    r.stderr.includes("run: & '/w/real/npm' update -g '@jboho/safe-pnpm'"),
    r.stderr,
  );
  assert.equal(r.stdout, "");
});

test("ps1 shim: child_process.spawn('pnpm') from node hits the shim", {
  skip,
}, () => {
  const r = result("node spawn");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MAL-2099-1/);
  assert.equal(r.calls, "");
});

test("ps1 shim: NAME.ps1 runs the same shim for a PowerShell session without the profile", {
  skip,
}, () => {
  const ok = result("ps1 argv");
  assert.equal(ok.status, 4, ok.stderr);
  assert.equal(ok.calls, 'RAN pnpm\nrun\nbuild\na b\n\nq"q\n');
  assert.equal(ok.stdout, "STUB OUT\n");
  const bad = result("ps1 mal");
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /MAL-2099-1/);
  assert.equal(bad.calls, "");
});
