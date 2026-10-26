// The NAME.cmd shims on Windows, run through cmd.exe as cross-spawn, Node's
// spawn with shell: true and safe-pnpm exec start them. It needs Windows and
// writes to the real home directory (pwsh's $HOME, which the shim reads, does
// not follow USERPROFILE), so it only runs in CI. ps1-path-shim.test.js covers
// path-shim.ps1 itself on any OS with Docker.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const skip =
  process.platform === "win32" && process.env.CI
    ? false
    : "needs Windows in CI";
const ASSETS = path.join(__dirname, "..", "assets");
const BIN = path.join(__dirname, "..", "bin", "safe-pnpm.js");
const NAMES = ["pnpm", "pnpx", "npm", "npx", "yarn"];

let tmp;
let real;
let osv;
let registry;
let shims;

before(async () => {
  if (skip) return;
  shims = require("../lib/util/shims");
  const { startOsvStub } = require("./helpers/osv-stub");
  // npm view (run by the scanner through npm-cli.js, not the shim) reads this.
  const { startRegistryStub } = require("./helpers/registry-stub");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-cmdshim-"));
  const safe = path.dirname(shims.SHIM_DIR);
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
  fs.writeFileSync(
    path.join(safe, "config.json"),
    JSON.stringify({ enabledManagers: ["pnpm", "npm", "yarn"] }),
  );
  shims.installShims(["pnpm", "npm", "yarn"], "win32");

  // The real binaries: NAME.cmd stubs that log argv one per line, print
  // STUB OUT and exit with STUB_EXIT; `pnpm run nested` runs pnpm again by name,
  // and `pnpm run echo` copies stdin to stdout.
  real = path.join(tmp, "real");
  fs.mkdirSync(real);
  fs.writeFileSync(
    path.join(real, "stub.js"),
    `const fs = require("node:fs");
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, ["RAN " + name, ...args].join("\\n") + "\\n");
if (name === "pnpm" && args[0] === "run" && args[1] === "nested") {
  const r = require("node:child_process").spawnSync("pnpm dlx mal-pkg", { shell: true, stdio: "inherit" });
  process.exit(r.status);
}
if (name === "pnpm" && args[0] === "run" && args[1] === "echo") {
  process.stdout.write(fs.readFileSync(0));
  process.exit(0);
}
process.stdout.write("STUB OUT\\n");
process.exit(Number(process.env.STUB_EXIT || 0));
`,
  );
  for (const name of NAMES) {
    fs.writeFileSync(
      path.join(real, `${name}.cmd`),
      `@"${process.execPath}" "%~dp0stub.js" ${name} %*\r\n`,
    );
  }
  osv = await startOsvStub();
  registry = await startRegistryStub();
});

after(() => {
  if (skip) return;
  osv.stop();
  registry.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let runs = 0;
function run(argv, { env = {}, shell = false, input } = {}) {
  const log = path.join(tmp, `calls-${runs++}`);
  fs.writeFileSync(log, "");
  const key =
    Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "Path";
  const childEnv = {
    ...process.env,
    [key]: `${shims.SHIM_DIR};${real};${process.env[key]}`,
    SAFE_PNPM_OSV_API: `${osv.url}/ok`,
    npm_config_registry: registry.url,
    STUB_LOG: log,
    ...env,
  };
  let r;
  if (shell) {
    r = spawnSync(argv.join(" "), {
      shell: true,
      encoding: "utf8",
      input,
      env: childEnv,
      cwd: tmp,
      timeout: 120000,
    });
  } else {
    const c = shims.spawnCommand(
      argv,
      { ...childEnv, PATH: childEnv[key] },
      "win32",
    );
    r = spawnSync(c.file, c.args, {
      ...c.options,
      encoding: "utf8",
      input,
      env: childEnv,
      cwd: tmp,
      timeout: 120000,
    });
  }
  assert.equal(r.error, undefined, String(r.error));
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: fs.readFileSync(log, "utf8"),
  };
}

test("cmd shim: spawn with shell: true finds pnpm.cmd, and a malicious dlx is blocked", {
  skip,
}, () => {
  const r = run(["pnpm", "dlx", "mal-pkg"], { shell: true });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
  assert.equal(r.stdout, "");
  assert.equal(r.calls, "");
});

test("cmd shim: every name is checked", { skip }, () => {
  for (const argv of [
    ["pnpx", "mal-pkg"],
    ["npx", "mal-pkg"],
    ["npm", "exec", "mal-pkg"],
    ["yarn", "dlx", "mal-pkg"],
  ]) {
    const r = run(argv);
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /MAL-2099-1/);
    assert.equal(r.calls, "", argv.join(" "));
  }
});

test("cmd shim: arguments and the exit code pass through", { skip }, () => {
  const args = ["run", "build", "a b", "--", "x=y"];
  const r = run(["pnpm", ...args], { env: { STUB_EXIT: "7" } });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stdout, "STUB OUT\n");
  assert.equal(r.calls, `RAN pnpm\n${args.join("\n")}\n`);
  // The real launchers are .cmd files too, which PowerShell would call with
  // Legacy argument passing: '' dropped, q"q unescaped, a&b split by cmd.exe.
  // Both hops (this test's spawnCommand and the wrapper's cmd.exe call)
  // escape twice for the launcher's %* reparse, so a " and an & in one
  // command line arrive intact.
  const more = ["", 'q"q', "a&b", "x|y", "c^d", "^", "(p)", "%PATH%", "back\\"];
  const m = run(["pnpm", "run", ...more]);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(m.calls, `RAN pnpm\nrun\n${more.join("\n")}\n`);
  const clean = run(["pnpm", "dlx", "cowsay@latest"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "STUB OUT\n");
});

test("cmd shim: the profile function's output from a .cmd launcher can be captured", {
  skip,
}, () => {
  // pnpm here is the profile function, which runs the real pnpm.cmd through
  // _Safe_Pkg_Run_Native; its output must reach $v, not the console.
  const args = ["run", "a b", "", 'q"q', "a&b", "x|y", "%PATH%", "^"];
  const ps = (a) => `'${a.replace(/'/g, "''")}'`;
  const script = [
    '. "$HOME\\.safe-pnpm\\pnpm-wrapper.ps1"',
    `$v = pnpm ${args.map(ps).join(" ")}`,
    '"captured=[$v] rc=$LASTEXITCODE"',
    `pnpm run x | ForEach-Object { "piped:$_" }`,
    "exit 0",
  ].join("; ");
  const r = run(["pwsh", "-NoProfile", "-Command", script], {
    env: { STUB_EXIT: "4" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout.replace(/\r\n/g, "\n"),
    "captured=[STUB OUT] rc=4\npiped:STUB OUT\n",
  );
  assert.equal(r.calls, `RAN pnpm\n${args.join("\n")}\nRAN pnpm\nrun\nx\n`);
});

test("cmd shim: a profile that sets Standard argument passing still works", {
  skip,
}, () => {
  // Under Standard, PowerShell would split and re-quote the --% line that
  // _Safe_Pkg_Run_Native hands to cmd.exe; the function forces Legacy for
  // its own call and leaves the caller's setting alone.
  const args = ["run", "a b", "", 'q"q', "a&b", "x|y", "%PATH%", "^"];
  const ps = (a) => `'${a.replace(/'/g, "''")}'`;
  const script = [
    "$PSNativeCommandArgumentPassing = 'Standard'",
    '. "$HOME\\.safe-pnpm\\pnpm-wrapper.ps1"',
    `$v = pnpm ${args.map(ps).join(" ")}`,
    '"captured=[$v] rc=$LASTEXITCODE caller=$PSNativeCommandArgumentPassing"',
    "exit 0",
  ].join("; ");
  const r = run(["pwsh", "-NoProfile", "-Command", script], {
    env: { STUB_EXIT: "4" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout.replace(/\r\n/g, "\n"),
    "captured=[STUB OUT] rc=4 caller=Standard\n",
  );
  assert.equal(r.calls, `RAN pnpm\n${args.join("\n")}\n`);
});

test("cmd shim: stdin and stdout pass through byte for byte", { skip }, () => {
  const input = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n\u00e9 \r\n';
  const r = run(["pnpm", "run", "echo"], { input });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, input);
});

test("cmd shim: a package manager started by the real one is intercepted again", {
  skip,
}, () => {
  const r = run(["pnpm", "run", "nested"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.calls, "RAN pnpm\nrun\nnested\n");
  assert.match(r.stderr, /MAL-2099-1/);
});

test("cmd shim: safe-pnpm exec puts the shims first on PATH", { skip }, () => {
  const key =
    Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "Path";
  const r = run(
    [process.execPath, BIN, "exec", "--", "pnpm", "dlx", "mal-pkg"],
    {
      env: { [key]: `${real};${process.env[key]}` },
    },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MAL-2099-1/);
  assert.equal(r.calls, "");
});
