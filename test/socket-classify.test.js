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
  const { code } = classify(
    JSON.stringify({ ok: true, data: { healthy: true } }),
  );
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

// A non-numeric exit arg parses to NaN; Number.isInteger(NaN) is false, so both
// the exit-2 guard and the nonzero-exit contradiction check are deliberately
// skipped. A healthy envelope must still pass rather than crash.
test("NaN/non-numeric socketExit argument is treated safely", () => {
  const { code } = classify(
    JSON.stringify({ ok: true, data: { healthy: true } }),
    "abc",
  );
  assert.equal(code, PASS);
});

test("ok:false with unhealthy data also present is a scan failure", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: false, cause: "timeout", data: { healthy: false } }),
    1,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /timeout/);
});

test("ok:false with neither cause nor message falls back to unknown error", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: false, data: { code: 500 } }),
    1,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /unknown error/i);
});

test("ok:false with message but no cause uses the message fallback", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: false, message: "Bad request", data: { code: 400 } }),
    1,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /Bad request/);
});

// The exit-2 config guard runs before the report is read, so it must win even
// over a body that would otherwise classify as FINDINGS.
test("config-error exit wins over unhealthy findings", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: true, data: { healthy: false } }),
    2,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /socket login/);
});

test("healthy key present but not boolean is a scan failure", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: true, data: { healthy: 1 } }),
    0,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /no report verdict/);
});

test("data is null while ok:true is a scan failure", () => {
  const { code, reason } = classify(
    JSON.stringify({ ok: true, data: null }),
    0,
  );
  assert.equal(code, FAILED);
  assert.match(reason, /no report verdict/);
});

test("valid JSON array body does not crash the classifier", () => {
  const { code, reason } = classify("[1,2,3]", 1);
  assert.equal(code, FAILED);
  assert.match(reason, /no report verdict/);
});

test("ok field absent with healthy:true still passes", () => {
  const { code } = classify(JSON.stringify({ data: { healthy: true } }), 0);
  assert.equal(code, PASS);
});

test("ok field absent with healthy:false is still findings", () => {
  const { code, reason } = classify(
    JSON.stringify({ data: { healthy: false } }),
    1,
  );
  assert.equal(code, FINDINGS);
  assert.match(reason, /policy violations/i);
});

test("top-level JSON number is an unrecognized result", () => {
  const { code, reason } = classify("42", 1);
  assert.equal(code, FAILED);
  assert.match(reason, /unrecognized result/i);
});

test("top-level JSON null is an unrecognized result", () => {
  const { code, reason } = classify("null", 1);
  assert.equal(code, FAILED);
  assert.match(reason, /unrecognized result/i);
});

test("top-level JSON string scalar is an unrecognized result", () => {
  const { code, reason } = classify('"done"', 1);
  assert.equal(code, FAILED);
  assert.match(reason, /unrecognized result/i);
});

// The existing "missing output file" test writes no file but passes a real
// (truthy) path, hitting the readFileSync catch. Passing "" hits the earlier
// argv-level guard instead.
test("empty string outputFile argument is a scan failure", () => {
  const r = spawnSync("node", [CLASSIFIER, "", "0"], { encoding: "utf8" });
  assert.equal(r.status, FAILED);
  assert.match(r.stderr.trim(), /no output file to classify/);
});
