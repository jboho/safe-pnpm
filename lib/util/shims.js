const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const INSTALL_DIR = path.join(os.homedir(), ".safe-pnpm");
const SHIM_DIR = path.join(INSTALL_DIR, "bin");
const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");
const SHIM_ASSET = path.join(ASSETS_DIR, "path-shim.sh");
// On Windows each NAME.cmd and NAME.ps1 in SHIM_DIR runs this one script,
// installed beside the wrappers so PowerShell does not offer it as a command.
const PS_SHIM_ASSET = path.join(ASSETS_DIR, "path-shim.ps1");
const PS_SHIM_FILE = path.join(INSTALL_DIR, "path-shim.ps1");
const ALL_NAMES = ["pnpm", "pnpx", "npm", "npx", "yarn"];
// Not containing "# safe-pnpm", so hasSourceLine never mistakes it for the
// wrapper block.
const PATH_MARKER = "# PATH shims (safe-pnpm)";
const PATH_LINE = 'export PATH="$HOME/.safe-pnpm/bin:$PATH"';
// The same line for the PowerShell profile, the only PATH setup --path-shims
// writes on Windows.
const PS_PATH_LINE = '$env:PATH = "$HOME\\.safe-pnpm\\bin;$env:PATH"';
const PATH_LINES = [PATH_LINE, PS_PATH_LINE];
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

// staleWrapperFiles — the wrapper files the shims load (sh, or ps1 on
// Windows) that are missing from INSTALL_DIR or differ from this package's copy.
function staleWrapperFiles(managers, platform = process.platform) {
  const ext = platform === "win32" ? "ps1" : "sh";
  return [
    `_safe_pkg_shared.${ext}`,
    ...managers.map((m) => `${m}-wrapper.${ext}`),
  ].filter((f) => {
    try {
      return !fs
        .readFileSync(path.join(INSTALL_DIR, f))
        .equals(fs.readFileSync(path.join(ASSETS_DIR, f)));
    } catch {
      return true;
    }
  });
}

function shimNames(managers) {
  const extra = { npm: ["npm", "npx"], pnpm: ["pnpm", "pnpx"] };
  return managers.flatMap((mgr) => extra[mgr] ?? [mgr]);
}

// The files one shim name is installed as: a copy of path-shim.sh, or on
// Windows NAME.cmd and NAME.ps1.
function shimFileNames(name, platform = process.platform) {
  return platform === "win32" ? [`${name}.cmd`, `${name}.ps1`] : [name];
}

// cmd.exe expands %*; pwsh -File hands each argument to the script as is.
// -ExecutionPolicy Bypass: the shim is a local file safe-pnpm wrote, and a
// Restricted policy would otherwise stop every package manager call. No
// -NonInteractive: the wrappers only prompt when stdin is a console, as the
// sh shim does, and spawned programs have no console stdin.
function windowsShimContent(name, file) {
  if (file.endsWith(".cmd")) {
    return [
      "@echo off",
      "rem safe-pnpm PATH shim; see path-shim.ps1 in the parent directory.",
      "where pwsh >nul 2>nul || goto nopwsh",
      `pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\path-shim.ps1" ${name} %*`,
      "exit /b %ERRORLEVEL%",
      ":nopwsh",
      // A goto, not a ( ) block: %~dp0 expands inside a block before it is
      // parsed, and a ) in the home path would end the block early.
      `echo safe-pnpm: pwsh, PowerShell 7, is not on PATH, so ${name} was not run. Install PowerShell 7, or take %~dp0 off PATH. 1>&2`,
      "exit /b 1",
      "",
    ].join("\r\n");
  }
  return [
    "# safe-pnpm PATH shim; see path-shim.ps1 in the parent directory. It runs",
    "# in its own pwsh process, like the .cmd shim, so its output and exit code",
    "# are those of a separate program.",
    `& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'path-shim.ps1') ${name} @args`,
    "exit $LASTEXITCODE",
    "",
  ].join("\n");
}

// installShims — writes the shims for the enabled managers and removes shims
// for managers no longer enabled: a shim whose wrapper is missing refuses to
// run. On Windows also installs path-shim.ps1 and removes any sh-style shims.
function installShims(managers, platform = process.platform) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const names = shimNames(managers);
  const win = platform === "win32";
  if (win) fs.copyFileSync(PS_SHIM_ASSET, PS_SHIM_FILE);
  for (const name of ALL_NAMES) {
    const files = shimFileNames(name, platform);
    const other = win ? [name] : shimFileNames(name, "win32");
    for (const file of other)
      fs.rmSync(path.join(SHIM_DIR, file), { force: true });
    for (const file of files) {
      const dest = path.join(SHIM_DIR, file);
      if (!names.includes(name)) {
        fs.rmSync(dest, { force: true });
      } else if (win) {
        fs.writeFileSync(dest, windowsShimContent(name, file), "utf8");
      } else {
        fs.copyFileSync(SHIM_ASSET, dest);
        fs.chmodSync(dest, 0o755);
      }
    }
  }
  return names;
}

function missingShims(managers, platform = process.platform) {
  if (platform === "win32" && !fs.existsSync(PS_SHIM_FILE)) {
    return shimNames(managers);
  }
  return shimNames(managers).filter((name) => {
    try {
      for (const file of shimFileNames(name, platform)) {
        fs.accessSync(
          path.join(SHIM_DIR, file),
          platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
      }
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

const delimiterFor = (platform) => (platform === "win32" ? ";" : ":");

// findOnPath — every executable named `name` on pathValue, in lookup order.
// On Windows that is name plus each PATHEXT extension in each directory, the
// lookup cmd.exe and cross-spawn make (PowerShell also finds NAME.ps1).
function findOnPath(
  name,
  pathValue = process.env.PATH || "",
  platform = process.platform,
  pathExt = process.env.PATHEXT,
) {
  const win = platform === "win32";
  const exts = win
    ? ["", ...(pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const found = [];
  for (const dir of pathValue.split(delimiterFor(platform))) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        else if (!ext && !path.extname(name)) continue;
        found.push(file);
      } catch {
        // not here
      }
    }
  }
  return found;
}

function isShim(file) {
  const shim = realDir(SHIM_DIR);
  return shim !== null && realDir(path.dirname(file)) === shim;
}

function onPath(
  pathValue = process.env.PATH || "",
  platform = process.platform,
) {
  const shim = realDir(SHIM_DIR);
  if (!shim) return false;
  return pathValue
    .split(delimiterFor(platform))
    .some((d) => d && realDir(d) === shim);
}

// shimPath — pathValue with the shim directory first, for safe-pnpm exec.
function shimPath(pathValue, platform = process.platform) {
  return [SHIM_DIR, pathValue].filter(Boolean).join(delimiterFor(platform));
}

// cmd.exe metacharacters, escaped with ^ the way cross-spawn does.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// cmdQuote — one argument for a cmd.exe /s /c line that runs a .cmd file:
// quoted for the program's argument parser, then every cmd.exe metacharacter
// escaped. cmd.exe still expands %VAR% for a variable that exists, and the
// .cmd shim's %* is parsed by cmd.exe again; docs/security.md lists the limits.
function cmdQuote(arg) {
  const quoted = `"${String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

// spawnCommand — the file, arguments and spawn options that run argv with
// env. Elsewhere that is argv as is. On Windows a bare name is looked up on
// env's PATH with PATHEXT, so NAME.cmd shims are found, and a .cmd or .bat
// file runs through cmd.exe with each argument quoted, since spawn without a
// shell cannot start one and spawn with shell: true does not quote.
function spawnCommand(argv, env, platform = process.platform) {
  const [cmd, ...rest] = argv;
  if (platform !== "win32") return { file: cmd, args: rest, options: {} };
  const bare = !/[\\/]/.test(cmd);
  const file = bare
    ? findOnPath(cmd, env.PATH || env.Path || "", platform, env.PATHEXT)[0] ||
      cmd
    : cmd;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: rest, options: {} };
  const line = [file.replace(CMD_META, "^$1"), ...rest.map(cmdQuote)].join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

const bare = (line) => line.replace(/\r$/, "");

// stripBlock — drops the marker, its PATH line and the blank line
// addPathShims put before the marker.
function stripBlock(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (bare(lines[i]) === PATH_MARKER) {
      if (PATH_LINES.includes(bare(lines[i + 1] ?? ""))) i++;
      if (out.length > 0 && bare(out[out.length - 1]) === "") out.pop();
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

// addPathShims — puts the shim directory first on PATH in rcFile by appending
// a block at the end, after any line that prepends to PATH. Run again, it
// leaves a block that is still last alone and moves one that a later line
// would override. Returns "added", "moved" or "unchanged". line is PATH_LINE
// for an sh rc file, PS_PATH_LINE for the PowerShell profile.
function addPathShims(rcFile, line = PATH_LINE) {
  const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf8") : "";
  const lines = content.split("\n");
  const at = lines.findIndex((l) => bare(l) === PATH_MARKER);
  if (
    at !== -1 &&
    !lines
      .slice(at + 2)
      .some((l) => !l.trim().startsWith("#") && PREPENDS.test(l))
  ) {
    return "unchanged";
  }
  const kept = stripBlock(lines).join("\n").replace(/\n*$/, "\n");
  const prefix = kept === "\n" ? "" : kept;
  fs.writeFileSync(rcFile, `${prefix}\n${PATH_MARKER}\n${line}\n`, "utf8");
  return at === -1 ? "added" : "moved";
}

// removePathShims — takes the block back out. Returns true when it was there.
function removePathShims(rcFile) {
  if (!fs.existsSync(rcFile)) return false;
  const lines = fs.readFileSync(rcFile, "utf8").split("\n");
  if (!lines.some((l) => bare(l) === PATH_MARKER)) return false;
  fs.writeFileSync(rcFile, stripBlock(lines).join("\n"), "utf8");
  return true;
}

module.exports = {
  ALL_NAMES,
  SHIM_DIR,
  PS_SHIM_FILE,
  PATH_MARKER,
  PATH_LINE,
  PS_PATH_LINE,
  shimNames,
  shimFileNames,
  readEnabledManagers,
  staleWrapperFiles,
  installShims,
  missingShims,
  findOnPath,
  isShim,
  onPath,
  shimPath,
  cmdQuote,
  spawnCommand,
  addPathShims,
  removePathShims,
};
