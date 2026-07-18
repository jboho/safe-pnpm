const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHARED_SH = path.join(__dirname, "..", "assets", "_safe_pkg_shared.sh");

// Runs a bash snippet with HOME pointed at a fresh temp dir that contains a
// stub `socket` binary. The stub records its invocation so tests can assert
// whether the Socket behavioral scan actually ran.
function runShared(snippet, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-socket-"));
  const safeDir = path.join(home, ".safe-pnpm");
  fs.mkdirSync(safeDir, { recursive: true });

  const marker = path.join(safeDir, "socket-invoked");
  fs.writeFileSync(
    path.join(safeDir, "socket"),
    `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`,
    { mode: 0o755 },
  );

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
