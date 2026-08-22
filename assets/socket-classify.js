#!/usr/bin/env node

/**
 * Socket scan result classifier.
 *
 * `socket scan create --report --json` exits 1 both when the scan could not be
 * run (bad token, network/API error) and when the scan ran and the report was
 * unhealthy. safe-pnpm treats those two cases very differently, so the exit
 * code alone is not enough to decide. This reads the JSON envelope and maps it
 * onto three distinct outcomes.
 *
 * Usage:
 *   socket scan create . --report --json ... > out.json; node socket-classify.js out.json <socket-exit-code>
 *
 * Exit codes:
 *   0 — PASS:    scan ran, report healthy
 *   3 — FINDINGS: scan ran, report unhealthy (policy violations at report level)
 *   4 — FAILED:  scan could not be run or produced no usable result
 *
 * A one-line human-readable reason is written to stderr for the caller to show.
 */

const fs = require("fs");

const EXIT_PASS = 0;
const EXIT_FINDINGS = 3;
const EXIT_FAILED = 4;

// `socket` exits 2 for input/config errors (missing API token, no org
// resolvable). Those are always setup failures, never findings.
const SOCKET_EXIT_CONFIG_ERROR = 2;

function fail(reason) {
  console.error(reason);
  process.exit(EXIT_FAILED);
}

function main() {
  const [, , outputFile, socketExitRaw] = process.argv;
  const socketExit = Number.parseInt(socketExitRaw, 10);

  if (!outputFile) {
    fail("Socket scan produced no output file to classify.");
  }

  if (Number.isInteger(socketExit) && socketExit === SOCKET_EXIT_CONFIG_ERROR) {
    fail(
      "Socket is not configured (no API token or organization) — run `socket login`.",
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(outputFile, "utf8").trim();
  } catch (error) {
    fail(`Socket scan output could not be read: ${error.message}`);
  }

  if (!raw) {
    fail("Socket scan produced no output — the scan did not complete.");
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    // Non-JSON output means the CLI died before it could emit an envelope
    // (crash, killed process, unexpected version). Not a finding.
    fail("Socket scan output was not valid JSON — the scan did not complete.");
  }

  if (!result || typeof result !== "object") {
    fail("Socket scan returned an unrecognized result — the scan did not complete.");
  }

  // `ok: false` is the CLI's own signal that the command failed to produce a
  // result, regardless of why. Everything under it is a scan failure.
  if (result.ok === false) {
    const detail = result.cause || result.message || "unknown error";
    fail(`Socket scan could not run: ${detail}`);
  }

  const healthy = result.data && result.data.healthy;

  if (healthy === false) {
    console.error(
      "Socket reported policy violations for this dependency set.",
    );
    process.exit(EXIT_FINDINGS);
  }

  if (healthy !== true) {
    // `--report` was expected to yield a healthy flag. Its absence means we
    // cannot assert the dependencies were actually checked.
    fail(
      "Socket scan returned no report verdict — the scan did not complete.",
    );
  }

  if (Number.isInteger(socketExit) && socketExit !== 0) {
    // Envelope says healthy but the CLI still failed; trust the exit code and
    // do not claim the layer passed.
    fail(
      `Socket scan reported success but exited ${socketExit} — treating as incomplete.`,
    );
  }

  process.exit(EXIT_PASS);
}

if (require.main === module) {
  main();
}

module.exports = { EXIT_PASS, EXIT_FINDINGS, EXIT_FAILED };
