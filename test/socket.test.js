const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHARED_SH = path.join(__dirname, "..", "assets", "_safe_pkg_shared.sh");
const CLASSIFIER = path.join(__dirname, "..", "assets", "socket-classify.js");

// Runs a bash snippet with HOME pointed at a fresh temp dir containing a stub
// `socket` binary and the real classifier. The stub records its invocation so
// tests can assert whether the scan ran, and emits `socketStdout` with exit
// code `socketExit` so tests can drive each outcome of the failure semantics.
function runShared(snippet, env = {}, socketOpts = {}) {
  const {
    socketStdout = JSON.stringify({ ok: true, data: { healthy: true } }),
    socketExit = 0,
    installSocket = true,
  } = socketOpts;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-socket-"));
  const safeDir = path.join(home, ".safe-pnpm");
  fs.mkdirSync(safeDir, { recursive: true });

  fs.copyFileSync(CLASSIFIER, path.join(safeDir, "socket-classify.js"));

  const marker = path.join(safeDir, "socket-invoked");
  if (installSocket) {
    fs.writeFileSync(
      path.join(safeDir, "socket"),
      `#!/bin/sh\necho "$@" > "${marker}"\ncat <<'SOCKET_EOF'\n${socketStdout}\nSOCKET_EOF\nexit ${socketExit}\n`,
      { mode: 0o755 },
    );
  }

  const script = `set -e\nsource "${SHARED_SH}"\n${snippet}\n`;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    // No TTY: prescan runs in non-interactive mode, so it never blocks on a prompt.
    env: { ...process.env, ...env, HOME: home },
  });

  const invoked = fs.existsSync(marker);
  const invokedArgs = invoked ? fs.readFileSync(marker, "utf8").trim() : null;
  fs.rmSync(home, { recursive: true, force: true });
  return { ...r, invoked, invokedArgs };
}

test("Socket scan is skipped by default (no flag, no env)", () => {
  const { invoked } = runShared(
    `_safe_pkg_prescan pnpm nonexistent.lock 0`,
  );
  assert.equal(invoked, false);
});

test("Socket scan runs when the --socket flag is passed (socket_flag=1)", () => {
  const { invoked, invokedArgs } = runShared(
    `_safe_pkg_prescan pnpm nonexistent.lock 1`,
  );
  assert.equal(invoked, true);
  assert.ok(invokedArgs.startsWith("scan create ."));
});

test("Socket scan runs when SAFE_PNPM_ENABLE_SOCKET=1 (no flag)", () => {
  const { invoked } = runShared(`_safe_pkg_prescan pnpm nonexistent.lock 0`, {
    SAFE_PNPM_ENABLE_SOCKET: "1",
  });
  assert.equal(invoked, true);
});

test("SAFE_PNPM_ENABLE_SOCKET values other than 1 do not enable Socket", () => {
  const { invoked } = runShared(`_safe_pkg_prescan pnpm nonexistent.lock 0`, {
    SAFE_PNPM_ENABLE_SOCKET: "true",
  });
  assert.equal(invoked, false);
});

test("_safe_pkg_dispatch strips --socket and forwards the flag to prescan", () => {
  // Stub prescan + run so we capture exactly what dispatch passes through,
  // without needing Docker. Records go under $HOME/.safe-pnpm/.
  const snippet = `
_safe_pkg_prescan() { echo "$3" > "$HOME/.safe-pnpm/prescan-flag"; return 0; }
_safe_pkg_run() { shift 4; echo "$*" > "$HOME/.safe-pnpm/run-args"; return 0; }
_safe_pkg_dispatch pnpm pnpm-lock.yaml pnpm-workspace.yaml "package.json" install --socket lodash
echo "FLAG=$(cat "$HOME/.safe-pnpm/prescan-flag")"
echo "ARGS=$(cat "$HOME/.safe-pnpm/run-args")"
`;
  const { stdout, status } = runShared(snippet);
  assert.equal(status, 0);
  assert.match(stdout, /FLAG=1/);
  assert.match(stdout, /ARGS=install lodash/);
  assert.doesNotMatch(stdout, /--socket/);
});

test("_safe_pkg_dispatch passes socket_flag=0 and intact args when --socket absent", () => {
  const snippet = `
_safe_pkg_prescan() { echo "$3" > "$HOME/.safe-pnpm/prescan-flag"; return 0; }
_safe_pkg_run() { shift 4; echo "$*" > "$HOME/.safe-pnpm/run-args"; return 0; }
_safe_pkg_dispatch pnpm pnpm-lock.yaml pnpm-workspace.yaml "package.json" install lodash
echo "FLAG=$(cat "$HOME/.safe-pnpm/prescan-flag")"
echo "ARGS=$(cat "$HOME/.safe-pnpm/run-args")"
`;
  const { stdout } = runShared(snippet);
  assert.match(stdout, /FLAG=0/);
  assert.match(stdout, /ARGS=install lodash/);
});

// --- Failure semantics (M1) -------------------------------------------------
//
// The scan has three outcomes and safe-pnpm responds differently to each:
// pass, findings (scan ran, unhealthy report) and failure (scan could not run).
// All tests below run without a TTY, i.e. the non-interactive path.

const PRESCAN = `_safe_pkg_prescan pnpm nonexistent.lock 1`;

test("Socket scan passes a healthy report through", () => {
  const { status, stderr } = runShared(PRESCAN);
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /⚠️/);
});

test("Socket scan requests a report so findings can surface at all", () => {
  const { invokedArgs } = runShared(PRESCAN);
  assert.match(invokedArgs, /--report/);
  assert.match(invokedArgs, /--json/);
});

test("findings warn and continue in non-interactive mode", () => {
  const { status, stderr } = runShared(PRESCAN, {}, {
    socketStdout: JSON.stringify({ ok: true, data: { healthy: false } }),
    socketExit: 1,
  });
  assert.equal(status, 0);
  assert.match(stderr, /policy violations/i);
  assert.match(stderr, /non-interactive/);
});

test("findings block under SAFE_PNPM_SOCKET_STRICT=1", () => {
  const { status, stderr } = runShared(
    PRESCAN,
    { SAFE_PNPM_SOCKET_STRICT: "1" },
    {
      socketStdout: JSON.stringify({ ok: true, data: { healthy: false } }),
      socketExit: 1,
    },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /Blocking/);
});

// A scan that could not run is not evidence of a problem, so by default it must
// not break the install — the CVE and Shai Hulud layers have already run.
test("a failed scan warns and continues by default", () => {
  const { status, stderr } = runShared(PRESCAN, {}, {
    socketStdout: JSON.stringify({ ok: false, cause: "401 Unauthorized" }),
    socketExit: 1,
  });
  assert.equal(status, 0);
  assert.match(stderr, /could not run/i);
  assert.match(stderr, /Continuing without Socket results/);
});

test("a failed scan blocks under SAFE_PNPM_SOCKET_STRICT=1", () => {
  const { status, stderr } = runShared(
    PRESCAN,
    { SAFE_PNPM_SOCKET_STRICT: "1" },
    {
      socketStdout: JSON.stringify({ ok: false, cause: "401 Unauthorized" }),
      socketExit: 1,
    },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /Blocking/);
});

test("an unconfigured Socket (exit 2) warns with a login hint, not a findings claim", () => {
  const { status, stderr } = runShared(PRESCAN, {}, {
    socketStdout: "",
    socketExit: 2,
  });
  assert.equal(status, 0);
  assert.match(stderr, /socket login/);
  assert.doesNotMatch(stderr, /policy violations/i);
});

test("a missing Socket install warns by default but blocks under strict", () => {
  const lenient = runShared(PRESCAN, {}, { installSocket: false });
  assert.equal(lenient.status, 0);
  assert.match(lenient.stderr, /not installed/);

  const strict = runShared(
    PRESCAN,
    { SAFE_PNPM_SOCKET_STRICT: "1" },
    { installSocket: false },
  );
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /not installed/);
});

test("SAFE_PNPM_SOCKET_STRICT has no effect when Socket is not enabled", () => {
  const { status, invoked } = runShared(
    `_safe_pkg_prescan pnpm nonexistent.lock 0`,
    { SAFE_PNPM_SOCKET_STRICT: "1" },
    {
      socketStdout: JSON.stringify({ ok: false, cause: "401 Unauthorized" }),
      socketExit: 1,
    },
  );
  assert.equal(invoked, false);
  assert.equal(status, 0);
});
