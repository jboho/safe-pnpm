// The NAME.cmd shims on Windows, run through cmd.exe as cross-spawn, Node's
// spawn with shell: true and safe-pnpm exec start them. It needs Windows and
// writes to the real home directory (pwsh's $HOME, which the shim reads, does
// not follow USERPROFILE), so it only runs in CI. ps1-path-shim.test.js covers
// path-shim.ps1 itself on any OS with Docker.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
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

// npm view (run by the scanner through npm-cli.js, not the shim) reads this
// registry: every package has one version, 1.2.3.
function startRegistry() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": { name, version: "1.2.3" } },
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        stop: () => server.close(),
      }),
    );
  });
}

before(async () => {
  if (skip) return;
  shims = require("../lib/util/shims");
  const { startOsvStub } = require("./helpers/osv-stub");
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
  // STUB OUT and exit with STUB_EXIT; `pnpm run nested` runs pnpm again by name.
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
  registry = await startRegistry();
});

after(() => {
  if (skip) return;
  osv.stop();
  registry.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let runs = 0;
function run(argv, { env = {}, shell = false } = {}) {
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
  const clean = run(["pnpm", "dlx", "cowsay"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "STUB OUT\n");
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
