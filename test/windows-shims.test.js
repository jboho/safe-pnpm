// The Windows half of the PATH shims, run on any OS: the files installShims
// writes per platform, the PowerShell profile line, and how safe-pnpm exec
// builds PATH and finds a NAME.cmd. The shims themselves run in
// ps1-path-shim.test.js (pwsh) and windows-cmd-shims.test.js (cmd.exe).
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// shims.js reads the home directory when it loads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-winshims-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
const shims = require("../lib/util/shims");
const { pathShimTarget } = require("../lib/commands/setup");

const install = path.join(home, ".safe-pnpm");
const bin = path.join(install, "bin");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const listBin = () => fs.readdirSync(bin).sort();

test("installShims writes NAME.cmd and NAME.ps1 on Windows and the sh shim elsewhere", () => {
  // A shim from a release that wrote the sh shim on Windows too.
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\n");
  assert.deepEqual(shims.installShims(["pnpm", "npm"], "win32"), [
    "pnpm",
    "pnpx",
    "npm",
    "npx",
  ]);
  assert.deepEqual(listBin(), [
    "npm.cmd",
    "npm.ps1",
    "npx.cmd",
    "npx.ps1",
    "pnpm.cmd",
    "pnpm.ps1",
    "pnpx.cmd",
    "pnpx.ps1",
  ]);
  assert.ok(fs.existsSync(path.join(install, "path-shim.ps1")));
  assert.deepEqual(shims.missingShims(["pnpm", "npm"], "win32"), []);
  assert.deepEqual(shims.missingShims(["yarn"], "win32"), ["yarn"]);

  const cmd = fs.readFileSync(path.join(bin, "npx.cmd"), "utf8");
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(
    cmd.includes(
      'pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\path-shim.ps1" npx %*\r\n',
    ),
    cmd,
  );
  assert.match(cmd, /\r\nexit \/b %ERRORLEVEL%\r\n:nopwsh\r\n/);
  assert.match(cmd, /\r\nexit \/b 1\r\n$/);
  // No ( ) block, which a ) in the home path behind %~dp0 would end early.
  assert.doesNotMatch(cmd, /[()]/);
  assert.doesNotMatch(cmd.replace(/\r\n/g, ""), /\n/);
  const ps1 = fs.readFileSync(path.join(bin, "npx.ps1"), "utf8");
  assert.match(ps1, /'path-shim\.ps1'\) npx @args\nexit \$LASTEXITCODE\n$/);

  // Dropping a manager removes its shims; leaving Windows swaps the files.
  shims.installShims(["pnpm"], "win32");
  assert.deepEqual(listBin(), ["pnpm.cmd", "pnpm.ps1", "pnpx.cmd", "pnpx.ps1"]);
  shims.installShims(["pnpm", "yarn"], "linux");
  assert.deepEqual(listBin(), ["pnpm", "pnpx", "yarn"]);
  // Windows has no execute bits; missingShims below checks the file exists.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(bin, "yarn")).mode & 0o111, 0o111);
  }
  assert.deepEqual(shims.missingShims(["pnpm", "yarn"], "linux"), []);
  // Windows reports every shim missing until path-shim.ps1 is there too.
  shims.installShims(["pnpm"], "win32");
  fs.rmSync(path.join(install, "path-shim.ps1"));
  assert.deepEqual(shims.missingShims(["pnpm"], "win32"), ["pnpm", "pnpx"]);
});

test("staleWrapperFiles compares the ps1 wrappers on Windows", () => {
  assert.deepEqual(shims.staleWrapperFiles(["npm"], "win32"), [
    "_safe_pkg_shared.ps1",
    "npm-wrapper.ps1",
  ]);
  assert.deepEqual(shims.staleWrapperFiles(["npm"], "linux"), [
    "_safe_pkg_shared.sh",
    "npm-wrapper.sh",
  ]);
  for (const f of ["_safe_pkg_shared.ps1", "npm-wrapper.ps1"]) {
    fs.copyFileSync(
      path.join(__dirname, "..", "assets", f),
      path.join(install, f),
    );
  }
  assert.deepEqual(shims.staleWrapperFiles(["npm"], "win32"), []);
});

test("setup --path-shims on Windows edits the PowerShell profile, not the sh rc", () => {
  const target = pathShimTarget("win32");
  assert.equal(
    target.rcFile,
    path.join(
      home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    ),
  );
  assert.equal(target.line, '$env:PATH = "$HOME\\.safe-pnpm\\bin;$env:PATH"');
  assert.equal(pathShimTarget("linux").line, shims.PATH_LINE);
});

test("the PowerShell profile line is added once, moved behind later PATH changes, and removed", () => {
  const profile = path.join(root, "profile.ps1");
  const line = shims.PS_PATH_LINE;
  const before = `# safe-pnpm\r\n. "${path.join(install, "pnpm-wrapper.ps1")}"\r\n`;
  fs.writeFileSync(profile, before);

  assert.equal(shims.addPathShims(profile, line), "added");
  let content = fs.readFileSync(profile, "utf8");
  assert.ok(content.startsWith(before), content);
  assert.ok(content.endsWith(`# PATH shims (safe-pnpm)\n${line}\n`), content);
  assert.equal(shims.addPathShims(profile, line), "unchanged");
  assert.equal(fs.readFileSync(profile, "utf8"), content);

  for (const later of [
    '$env:Path += ";C:\\tools"',
    "fnm env --use-on-cd | Out-String | Invoke-Expression",
    '$env:PNPM_HOME = "C:\\pnpm"',
  ]) {
    fs.appendFileSync(profile, `${later}\r\n`);
    assert.equal(shims.addPathShims(profile, line), "moved", later);
    content = fs.readFileSync(profile, "utf8");
    assert.equal(content.split(line).length, 2, content);
    assert.ok(content.indexOf(later) < content.indexOf(line), content);
  }

  assert.equal(shims.removePathShims(profile), true);
  content = fs.readFileSync(profile, "utf8");
  assert.doesNotMatch(content, /PATH shims|\.safe-pnpm\\bin/);
  assert.ok(content.startsWith(before), content);
  assert.equal(shims.removePathShims(profile), false);

  // A block an editor saved with CRLF is still found and removed.
  fs.writeFileSync(
    profile,
    `${before}\r\n# PATH shims (safe-pnpm)\r\n${line}\r\n`,
  );
  assert.equal(shims.addPathShims(profile, line), "unchanged");
  assert.equal(shims.removePathShims(profile), true);
  assert.equal(fs.readFileSync(profile, "utf8"), `${before}`);
});

// Lowercase PATHEXT, so the names match on a disk that is case-sensitive.
test("findOnPath uses PATHEXT and ; on Windows", () => {
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "pnpm"), "");
  fs.writeFileSync(path.join(a, "pnpm.ps1"), "");
  fs.writeFileSync(path.join(b, "pnpm.exe"), "");
  fs.writeFileSync(path.join(b, "pnpm.cmd"), "");
  const found = shims.findOnPath("pnpm", `${a};${b}`, "win32", ".exe;.cmd");
  assert.deepEqual(
    found.map((f) => path.basename(f)),
    ["pnpm.exe", "pnpm.cmd"],
  );
  assert.equal(path.dirname(found[0]), b);
  assert.deepEqual(
    shims
      .findOnPath("pnpm.cmd", `${a};${b}`, "win32", ".exe")
      .map((f) => path.basename(f)),
    ["pnpm.cmd"],
  );
});

test("safe-pnpm exec builds PATH with the platform's separator", () => {
  assert.equal(shims.shimPath("C:\\x;C:\\y", "win32"), `${bin};C:\\x;C:\\y`);
  assert.equal(shims.shimPath("/usr/bin", "linux"), `${bin}:/usr/bin`);
  assert.equal(shims.shimPath("", "win32"), bin);
});

test("safe-pnpm exec runs a NAME.cmd through cmd.exe with every argument quoted", () => {
  const dir = path.join(root, "cmd");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "pnpm.cmd"), "");
  fs.writeFileSync(path.join(dir, "node.exe"), "");
  const env = {
    PATH: dir,
    PATHEXT: ".exe;.cmd",
    SystemRoot: "D:\\Win",
    ComSpec: "C:\\evil\\cmd.exe",
  };
  const r = shims.spawnCommand(
    ["pnpm", "run", "a b", 'say "hi"', "x&y", "100%", "trail\\"],
    env,
    "win32",
  );
  // The system cmd.exe, never ComSpec.
  assert.equal(r.file, "D:\\Win\\System32\\cmd.exe");
  assert.equal(
    shims.spawnCommand(["pnpm"], { PATH: dir, PATHEXT: ".cmd" }, "win32").file,
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.deepEqual(r.options, { windowsVerbatimArguments: true });
  assert.deepEqual(r.args.slice(0, 3), ["/d", "/s", "/c"]);
  const file = path
    .join(dir, "pnpm.cmd")
    .replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
  // Escaped twice: once for the /c line, once for the launcher's %* reparse.
  assert.equal(
    r.args[3],
    `"${file} ^^^"run^^^" ^^^"a^^^ b^^^" ^^^"say^^^ \\^^^"hi\\^^^"^^^" ^^^"x^^^&y^^^" ^^^"100^^^%^^^" ^^^"trail\\\\^^^""`,
  );
  // An .exe, or a path, runs as is; other platforms never change argv.
  assert.deepEqual(shims.spawnCommand(["node", "-v"], env, "win32"), {
    file: path.join(dir, "node.exe"),
    args: ["-v"],
    options: {},
  });
  assert.deepEqual(shims.spawnCommand(["pnpm", "a b"], env, "linux"), {
    file: "pnpm",
    args: ["a b"],
    options: {},
  });
  assert.equal(shims.cmdQuote(""), '^^^"^^^"');
});

// Simulates the two cmd.exe parses a .cmd launcher's arguments go through:
// the /c line, then the launcher's %* line. Each strips one level of carets,
// and an unescaped metacharacter outside quotes is a failure. Returns the
// text the launcher hands its program, or throws.
function cmdParse(line) {
  let out = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "^") {
      out += line[++i];
      continue;
    }
    if (!quoted && "&|<>".includes(c)) throw new Error(`cmd acts on ${c}`);
    out += c;
  }
  return out;
}

// The program's own argv split (MSVCRT rules) of what the launcher hands it.
function msvcrtSplit(s) {
  const args = [];
  let cur = "";
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      inArg = true;
    } else if (c === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (c === " " && !quoted) {
      if (inArg) args.push(cur);
      cur = "";
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (inArg) args.push(cur);
  return args;
}

test("cmdQuote survives the launcher's second cmd.exe parse", () => {
  for (const argv of [
    ['q"q', "a&b"],
    ["a|b"],
    ["%PATH%"],
    ["^"],
    [""],
    ['x"', "<y>", "c^d", "(p)", "back\\"],
  ]) {
    const line = argv.map(shims.cmdQuote).join(" ");
    const handed = cmdParse(cmdParse(line));
    assert.deepEqual(msvcrtSplit(handed), argv, JSON.stringify(argv));
  }
  // Escaped once, the quote in q"q flips cmd.exe's quote state on the
  // second parse and leaves a&b's & bare.
  const once = ['q"q', "a&b"].map((a) => shims.cmdQuoteOnce(a)).join(" ");
  assert.throws(() => cmdParse(cmdParse(once)));
});

test("spawnCommand escapes once for a .cmd or .bat that reads %1 itself", () => {
  const argv = ['q"q', "a&b", "a|b", "%PATH%", "^", "", "x y", "back\\"];
  const line = (file) =>
    shims.spawnCommand([file, ...argv], {}, "win32").args[3].slice(1, -1);
  // tool.bat sees its arguments after the /c line's single parse.
  const bat = line("C:\\x\\tool.bat");
  assert.equal(
    bat,
    `C:\\x\\tool.bat ${argv.map((a) => shims.cmdQuoteOnce(a)).join(" ")}`,
  );
  assert.deepEqual(msvcrtSplit(cmdParse(bat)).slice(1), argv);
  // The managers' launchers and the shims reparse %*, in any case.
  for (const f of ["C:\\x\\pnpm.cmd", "C:\\x\\NPX.CMD", "C:\\x\\yarn.bat"]) {
    assert.equal(
      line(f),
      `${f} ${argv.map((a) => shims.cmdQuote(a)).join(" ")}`,
      f,
    );
  }
});
