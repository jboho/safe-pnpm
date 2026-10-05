const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const PRESCAN_FISH = path.join(ASSETS, "_safe_pkg_prescan.fish");
const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;
const opts = { skip: !fishAvailable && "fish not installed" };

// Fish counterpart of the failure-semantics tests in socket.test.js and the
// strict-mode tests for the malware scan: HOME holds a stub `socket`, the real
// classifier and (optionally) the real malware scanner. Fish has no TTY here,
// so the non-interactive path runs.
function runFish(snippet, env = {}, o = {}) {
  const {
    socketStdout = JSON.stringify({ ok: true, data: { healthy: true } }),
    socketExit = 0,
    installSocket = true,
    installScanner = false,
  } = o;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-strictfish-"));
  const safeDir = path.join(home, ".safe-pnpm");
  fs.mkdirSync(safeDir, { recursive: true });
  fs.copyFileSync(
    path.join(ASSETS, "socket-classify.js"),
    path.join(safeDir, "socket-classify.js"),
  );
  if (installScanner) {
    fs.copyFileSync(
      path.join(ASSETS, "malware-scan.js"),
      path.join(safeDir, "malware-scan.js"),
    );
  }
  const marker = path.join(safeDir, "socket-invoked");
  if (installSocket) {
    fs.writeFileSync(
      path.join(safeDir, "socket"),
      `#!/bin/sh\necho "$@" > "${marker}"\ncat <<'SOCKET_EOF'\n${socketStdout}\nSOCKET_EOF\nexit ${socketExit}\n`,
      { mode: 0o755 },
    );
  }
  const r = spawnSync(
    "fish",
    ["-c", `source "${PRESCAN_FISH}"\n${snippet}\necho "RC=$status"`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SAFE_PNPM_STRICT: "",
        SAFE_PNPM_SOCKET_STRICT: "",
        SAFE_PNPM_OSV_STRICT: "",
        SAFE_PNPM_ENABLE_SOCKET: "",
        ...env,
        HOME: home,
      },
    },
  );
  const rc = Number(/RC=(\d+)/.exec(r.stdout)?.[1]);
  const invoked = fs.existsSync(marker);
  fs.rmSync(home, { recursive: true, force: true });
  return { ...r, rc, invoked };
}

const PRESCAN = `_safe_pkg_prescan pnpm nonexistent.lock 1`;
const unhealthy = {
  socketStdout: JSON.stringify({ ok: true, data: { healthy: false } }),
  socketExit: 1,
};
const failed = {
  socketStdout: JSON.stringify({ ok: false, cause: "401 Unauthorized" }),
  socketExit: 1,
};

test("fish: Socket scan passes a healthy report through", opts, () => {
  const r = runFish(PRESCAN);
  assert.equal(r.rc, 0);
  assert.ok(r.invoked, "scan ran");
});

test("fish: findings warn and continue when non-interactive", opts, () => {
  const r = runFish(PRESCAN, {}, unhealthy);
  assert.equal(r.rc, 0);
  assert.match(r.stderr, /policy violations/i);
  assert.match(r.stderr, /Non-interactive/i);
});

test("fish: findings block under SAFE_PNPM_SOCKET_STRICT=1", opts, () => {
  const r = runFish(PRESCAN, { SAFE_PNPM_SOCKET_STRICT: "1" }, unhealthy);
  assert.equal(r.rc, 1);
  assert.match(r.stderr, /Blocking \(SAFE_PNPM_SOCKET_STRICT=1\)/);
});

test("fish: findings block under SAFE_PNPM_STRICT=1", opts, () => {
  const r = runFish(PRESCAN, { SAFE_PNPM_STRICT: "1" }, unhealthy);
  assert.equal(r.rc, 1);
  assert.match(r.stderr, /Blocking/);
});

test("fish: a failed scan warns and continues by default", opts, () => {
  const r = runFish(PRESCAN, {}, failed);
  assert.equal(r.rc, 0);
  assert.match(r.stderr, /could not run/i);
  assert.match(r.stderr, /Continuing without Socket results/);
});

test("fish: a failed scan blocks under SAFE_PNPM_SOCKET_STRICT=1", opts, () => {
  const r = runFish(PRESCAN, { SAFE_PNPM_SOCKET_STRICT: "1" }, failed);
  assert.equal(r.rc, 1);
  assert.match(r.stderr, /Blocking \(SAFE_PNPM_SOCKET_STRICT=1\)/);
});

test("fish: a missing Socket install warns by default, blocks under strict", opts, () => {
  const lenient = runFish(PRESCAN, {}, { installSocket: false });
  assert.equal(lenient.rc, 0);
  assert.match(lenient.stderr, /not installed/);
  const strict = runFish(PRESCAN, { SAFE_PNPM_SOCKET_STRICT: "1" }, { installSocket: false });
  assert.equal(strict.rc, 1);
  assert.match(strict.stderr, /not installed/);
});

test("fish: SAFE_PNPM_SOCKET_STRICT has no effect when Socket is not enabled", opts, () => {
  const r = runFish(
    `_safe_pkg_prescan pnpm nonexistent.lock 0`,
    { SAFE_PNPM_SOCKET_STRICT: "1" },
    failed,
  );
  assert.equal(r.rc, 0);
  assert.equal(r.invoked, false);
});

// Malware scan: a scan that cannot run warns by default and blocks under
// either strict flag. (Findings blocking is covered per shell in
// two-phase.test.js.)
const MALWARE = `_safe_pkg_malware_scan /nonexistent/lock`;

test("fish: malware scan that cannot run warns by default", opts, () => {
  const r = runFish(MALWARE, {}, { installScanner: true });
  assert.equal(r.rc, 0);
  assert.match(r.stderr, /Continuing without it/);
});

for (const flag of ["SAFE_PNPM_OSV_STRICT", "SAFE_PNPM_STRICT"]) {
  test(`fish: malware scan that cannot run blocks under ${flag}=1`, opts, () => {
    const r = runFish(MALWARE, { [flag]: "1" }, { installScanner: true });
    assert.equal(r.rc, 1);
    assert.match(r.stderr, new RegExp(`Blocking \\(${flag}=1\\)`));
  });

  test(`fish: malware scanner not installed blocks under ${flag}=1`, opts, () => {
    const r = runFish(MALWARE, { [flag]: "1" });
    assert.equal(r.rc, 1);
    assert.match(r.stderr, /not installed/);
    assert.match(r.stderr, new RegExp(`Blocking \\(${flag}=1\\)`));
  });
}
