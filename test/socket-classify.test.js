const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLASSIFIER = path.join(__dirname, "..", "assets", "socket-classify.js");

const PASS = 0;
const FINDINGS = 3;
const FAILED = 4;

// Writes `body` to a temp file and classifies it as if `socket` exited with
// `socketExit`. Passing body = null omits the file entirely.
function classify(body, socketExit = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-classify-"));
  const file = path.join(dir, "out.json");
  if (body !== null) fs.writeFileSync(file, body);
  const r = spawnSync("node", [CLASSIFIER, file, String(socketExit)], {
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, reason: r.stderr.trim() };
}

test("healthy report passes", () => {
  const { code } = classify(JSON.stringify({ ok: true, data: { healthy: true } }));
  assert.equal(code, PASS);
});

test("unhealthy report is findings, not a scan failure", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: true, data: { healthy: false } }),
    1,
  );
  assert.equal(code, FINDINGS);
  assert.match(reason, /policy violations/i);
});

// Real envelope captured from `socket scan create . --report --json` against
// the API with an invalid token. Exit code 1 here means "could not run", which
// is the case that must not be mistaken for a finding.
test("API error envelope is a scan failure, not findings", () => {
  const { code, reason } = classify(
    JSON.stringify({
      ok: false,
      message: "Socket API error",
      cause: "Socket API POST request failed (401): Unauthorized",
      data: { code: 401 },
    }),
    1,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /401/);
});

// `socket` exits 2 for input/config errors before it ever contacts the API.
test("socket exit 2 is a configuration failure with a login hint", () => {
  const { code, reason } = classify("", 2);
  assert.equal(code, FAILED);
  assert.match(reason, /socket login/);
});

test("empty output is a scan failure", () => {
  const { code } = classify("", 1);
  assert.equal(code, FAILED);
});

test("non-JSON output is a scan failure", () => {
  const { code, reason } = classify("Killed: 9", 1);
  assert.equal(code, FAILED);
  assert.match(reason, /not valid JSON/);
});

test("missing output file is a scan failure", () => {
  const { code } = classify(null, 1);
  assert.equal(code, FAILED);
});

test("ok envelope without a report verdict is a scan failure", () => {
  const { code, reason } = classify(JSON.stringify({ ok: true, data: {} }), 0);
  assert.equal(code, FAILED);
  assert.match(reason, /no report verdict/);
});

test("healthy report contradicted by a nonzero exit is a scan failure", () => {
  const { code } = classify(
    JSON.stringify({ ok: true, data: { healthy: true } }),
    1,
  );
  assert.equal(code, FAILED);
});
