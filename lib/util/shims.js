const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const INSTALL_DIR = path.join(os.homedir(), ".safe-pnpm");
const SHIM_DIR = path.join(INSTALL_DIR, "bin");
const SHIM_ASSET = path.join(__dirname, "..", "..", "assets", "path-shim.sh");
const ALL_NAMES = ["pnpm", "pnpx", "npm", "npx", "yarn"];
// Not containing "# safe-pnpm", so hasSourceLine never mistakes it for the
// wrapper block.
const PATH_MARKER = "# PATH shims (safe-pnpm)";
const PATH_LINE = 'export PATH="$HOME/.safe-pnpm/bin:$PATH"';
// Lines that can put a directory before the shims on PATH: version managers
// and PNPM_HOME, `brew shellenv`, path_helper, and any assignment to PATH or
// zsh's path array. The shim line has to come after them.
const PREPENDS =
  /PNPM_HOME|nvm|volta|fnm|asdf|mise|corepack|shellenv|path_helper|\bPATH\s*\+?=|(^|[\s;])path\s*(\+?=|\[)/i;

function readEnabledManagers() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(INSTALL_DIR, "config.json"), "utf8"),
    );
    return config.enabledManagers || ["pnpm"];
  } catch {
    return ["pnpm"];
  }
}

// staleWrapperFiles — the sh files the shims source that are missing from
// INSTALL_DIR or differ from this package's copy.
function staleWrapperFiles(managers) {
  const assets = path.dirname(SHIM_ASSET);
  return ["_safe_pkg_shared.sh", ...managers.map((m) => `${m}-wrapper.sh`)].filter((f) => {
    try {
      return !fs.readFileSync(path.join(INSTALL_DIR, f)).equals(fs.readFileSync(path.join(assets, f)));
    } catch {
      return true;
    }
  });
}

function shimNames(managers) {
  const extra = { npm: ["npm", "npx"], pnpm: ["pnpm", "pnpx"] };
  return managers.flatMap((mgr) => extra[mgr] ?? [mgr]);
}

// installShims — writes one copy of path-shim.sh per name for the enabled
// managers and removes shims for managers no longer enabled: a shim whose
// wrapper is missing refuses to run.
function installShims(managers) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const names = shimNames(managers);
  for (const name of ALL_NAMES) {
    const dest = path.join(SHIM_DIR, name);
    if (names.includes(name)) {
      fs.copyFileSync(SHIM_ASSET, dest);
      fs.chmodSync(dest, 0o755);
    } else {
      fs.rmSync(dest, { force: true });
    }
  }
  return names;
}

function missingShims(managers) {
  return shimNames(managers).filter((name) => {
    try {
      fs.accessSync(path.join(SHIM_DIR, name), fs.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

// findOnPath — every executable named `name` on pathValue, in lookup order.
function findOnPath(name, pathValue = process.env.PATH || "") {
  const found = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      found.push(file);
    } catch {
      // not here
    }
  }
  return found;
}

function isShim(file) {
  const shim = realDir(SHIM_DIR);
  return shim !== null && realDir(path.dirname(file)) === shim;
}

function onPath(pathValue = process.env.PATH || "") {
  const shim = realDir(SHIM_DIR);
  if (!shim) return false;
  return pathValue.split(path.delimiter).some((d) => d && realDir(d) === shim);
}

// stripBlock — drops the marker, its PATH line and the blank line
// addPathShims put before the marker.
function stripBlock(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === PATH_MARKER) {
      if (lines[i + 1] === PATH_LINE) i++;
      if (out.length > 0 && out[out.length - 1] === "") out.pop();
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

// addPathShims — puts the shim directory first on PATH in rcFile by appending
// a block at the end, after any line that prepends to PATH. Run again, it
// leaves a block that is still last alone and moves one that a later line
// would override. Returns "added", "moved" or "unchanged".
function addPathShims(rcFile) {
  const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf8") : "";
  const lines = content.split("\n");
  const at = lines.indexOf(PATH_MARKER);
  if (
    at !== -1 &&
    !lines.slice(at + 2).some((l) => !l.trim().startsWith("#") && PREPENDS.test(l))
  ) {
    return "unchanged";
  }
  const kept = stripBlock(lines).join("\n").replace(/\n*$/, "\n");
  const prefix = kept === "\n" ? "" : kept;
  fs.writeFileSync(rcFile, `${prefix}\n${PATH_MARKER}\n${PATH_LINE}\n`, "utf8");
  return at === -1 ? "added" : "moved";
}

// removePathShims — takes the block back out. Returns true when it was there.
function removePathShims(rcFile) {
  if (!fs.existsSync(rcFile)) return false;
  const lines = fs.readFileSync(rcFile, "utf8").split("\n");
  if (!lines.includes(PATH_MARKER)) return false;
  fs.writeFileSync(rcFile, stripBlock(lines).join("\n"), "utf8");
  return true;
}

module.exports = {
  ALL_NAMES,
  SHIM_DIR,
  PATH_MARKER,
  PATH_LINE,
  shimNames,
  readEnabledManagers,
  staleWrapperFiles,
  installShims,
  missingShims,
  findOnPath,
  isShim,
  onPath,
  addPathShims,
  removePathShims,
};
