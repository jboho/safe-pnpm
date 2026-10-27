const fs = require("node:fs");
const path = require("node:path");

const PACKAGE = "@jboho/safe-pnpm";
const VERSION_RE = /^\d+(\.\d+)*$/;

function assertVersion(v) {
  if (!VERSION_RE.test(v)) {
    throw new Error(`npm returned an unexpected version: "${v}"`);
  }
  return v;
}

function isNewer(latest, installed) {
  const a = latest.split(".").map(Number);
  const b = installed.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Installs the newest published version globally when this copy is older.
// `run(file, args)` returns the command's stdout, or throws on failure.
// Returns the path of the global copy to run, or null when nothing changed.
function selfUpdate({ installed, run }) {
  const latest = assertVersion(run("npm", ["view", PACKAGE, "version"]).trim());
  if (!isNewer(latest, installed)) return null;

  run("npm", ["install", "-g", `${PACKAGE}@${latest}`], { inherit: true });

  const globalRoot = run("npm", ["root", "-g"]).trim();
  const bin = path.join(globalRoot, PACKAGE, "bin", "safe-pnpm.js");
  if (!fs.existsSync(bin)) {
    throw new Error(`npm installed ${latest} but ${bin} is missing`);
  }
  return bin;
}

module.exports = { selfUpdate, isNewer, PACKAGE };
