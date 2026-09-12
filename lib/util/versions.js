const { execFileSync } = require("node:child_process");

const REQUIREMENTS = {
  node: { major: 16, label: "16.0" },
  pnpm: { major: 7, label: "7.0" },
  npm: { major: 7, label: "7.0" },
  yarn: { major: 1, label: "1.0" },
  docker: { major: 20, label: "20.10" },
};

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function parseSemver(str) {
  if (!str) return null;
  const m = str.replace(/^v/, "").match(/^(\d+)\.(\d+)\.?(\d*)/);
  return m
    ? {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3] || 0, 10),
        raw: str,
      }
    : null;
}

// check(managers?) — managers defaults to ['pnpm'] for backward compatibility.
// Pass an array of manager names to check only those managers.
function check(managers) {
  const active = new Set(managers || ["pnpm"]);
  const results = [];

  // Node.js — always checked
  const nodeVer = parseSemver(process.version);
  results.push({
    name: "Node.js",
    ok: nodeVer && nodeVer.major >= REQUIREMENTS.node.major,
    found: nodeVer ? nodeVer.raw : "not found",
    required: `>= ${REQUIREMENTS.node.label}`,
  });

  // Per-manager checks
  for (const mgr of ["pnpm", "npm", "yarn"]) {
    if (!active.has(mgr)) continue;
    const out = run(mgr, ["--version"]);
    const ver = parseSemver(out);
    const req = REQUIREMENTS[mgr];
    results.push({
      name: mgr,
      ok: ver && ver.major >= req.major,
      found: ver ? ver.raw : "not found",
      required: `>= ${req.label}`,
    });
  }

  // Docker — always checked
  const dockerOut = run("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const dockerVer = parseSemver(dockerOut);
  results.push({
    name: "Docker",
    ok: dockerVer !== null,
    found: dockerVer ? dockerVer.raw : "not found",
    required: `>= ${REQUIREMENTS.docker.label}`,
  });

  return results;
}

module.exports = { check };
