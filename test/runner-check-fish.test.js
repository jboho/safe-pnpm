const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startOsvStub } = require("./helpers/osv-stub");

// Fish counterpart of test/runner-check.test.js: the download-and-run check in
// _safe_pkg_prescan.fish and the fish wrappers.
const ASSETS = path.join(__dirname, "..", "assets");
const PRESCAN = path.join(ASSETS, "_safe_pkg_prescan.fish");
const SHARED = path.join(ASSETS, "_safe_pkg_shared.sh");
const fishAvailable =
  spawnSync("fish", ["--version"], { stdio: "pipe" }).status === 0;
const opts = { skip: !fishAvailable && "fish not installed" };

// Same table as test/runner-check.test.js.
const RUNNERS = [
  ["npx", ["cowsay", "hi"], ["cowsay"]],
  ["npx", ["-y", "cowsay@1.5.0"], ["cowsay@1.5.0"]],
  ["npx", ["-p", "lodash", "-p", "cowsay", "cowsay"], ["lodash", "cowsay"]],
  ["npx", ["--package=foo", "bar"], ["foo"]],
  ["npx", ["--registry", "http://r", "cowsay"], ["cowsay"]],
  ["npx", ["--future-flag", "val", "cowsay"], ["val", "cowsay"]],
  ["npx", ["--", "cowsay"], ["cowsay"]],
  ["npm", ["exec", "cowsay"], ["cowsay"]],
  ["npm", ["--prefix", "web", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["x", "--", "cowsay"], ["cowsay"]],
  ["npm", ["init", "vite"], ["create-vite"]],
  ["npm", ["create", "@scope/foo"], ["@scope/create-foo"]],
  ["npm", ["create", "@scope"], ["@scope/create"]],
  ["npm", ["create", "@scope@2"], ["@scope/create@2"]],
  ["npm", ["init", "create-foo"], ["create-create-foo", "create-foo"]],
  ["pnpm", ["dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["-C", "web", "dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["create", "vite@latest", "app"], ["create-vite@latest"]],
  ["yarn", ["dlx", "cowsay"], ["cowsay"]],
  ["yarn", ["create", "react-app", "app"], ["create-react-app"]],
];

const OTHERS = [
  ["npm", ["install", "x"]],
  ["npm", ["run", "build"]],
  ["npm", ["--version"]],
  ["pnpm", ["exec", "cowsay"]],
  ["pnpm", ["add", "x"]],
  ["yarn", ["add", "x"]],
  ["yarn", []],
];

// Edge cases outside the table, where fish must print what bash prints.
const EDGES = [
  ["npx", []],
  ["npx", ["-c", "eslint ."]],
  ["npx", ["--package=", "x"]],
  ["npx", ["-p=mal-a", "-p", "b", "c"]],
  ["npx", ["--yes", "--quiet", "@acme/tool@^2", "arg"]],
  ["npx", ["--unknown", "--other", "x"]],
  ["npx", ["", "x"]],
  ["npm", ["EXEC", "cowsay"]],
  ["npm", ["exec"]],
  ["npm", ["create"]],
  ["npm", ["create", "@scope/create-foo@1"]],
  ["npm", ["init", "-y"]],
  ["npm", ["--", "exec", "x"]],
  ["npm", ["--loglevel=warn", "exec", "x"]],
  ["npm", ["run", "exec"]],
  ["pnpm", ["create", "@scope@latest", "dir"]],
  ["pnpm", ["--filter", "dlx", "add", "x"]],
  ["yarn", ["--cwd", "dlx", "create", "foo"]],
];

const fishSpecs = (manager, args) =>
  spawnSync(
    "fish",
    [
      "--no-config",
      "-c",
      "source $argv[1]; set -e argv[1]; _safe_pkg_runner_specs $argv",
      PRESCAN,
      manager,
      ...args,
    ],
    { encoding: "utf8" },
  );

test(
  "fish: _safe_pkg_runner_specs finds the packages a runner command fetches",
  opts,
  () => {
    for (const [manager, args, want] of RUNNERS) {
      const r = fishSpecs(manager, args);
      const label = `${manager} ${args.join(" ")}`;
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.deepEqual(r.stdout.split("\n").filter(Boolean), want, label);
    }
  },
);

test(
  "fish: _safe_pkg_runner_specs returns 1 for commands that fetch nothing to run",
  opts,
  () => {
    for (const [manager, args] of OTHERS) {
      const r = fishSpecs(manager, args);
      const label = `${manager} ${args.join(" ")}`;
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, "", label);
    }
  },
);

test(
  "fish: _safe_pkg_runner_specs agrees with the bash finder on edge cases",
  opts,
  () => {
    for (const [manager, args] of [...RUNNERS, ...OTHERS, ...EDGES]) {
      const label = `${manager} ${JSON.stringify(args)}`;
      const b = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; shift; _safe_pkg_runner_specs "$@"',
          "sh",
          SHARED,
          manager,
          ...args,
        ],
        { encoding: "utf8" },
      );
      const f = fishSpecs(manager, args);
      assert.equal(f.status, b.status, label);
      assert.deepEqual(
        f.stdout.split("\n").filter(Boolean),
        b.stdout.split("\n").filter(Boolean),
        label,
      );
    }
  },
);

// End to end: a throwaway HOME, the real scanner, the OSV stub, and stub
// `npm`, `npx`, `pnpm` and `yarn` binaries on PATH. The stub npm answers
// `npm view` (what the scanner resolves versions with) and logs every call;
// the other stubs log that they ran. A stub docker refuses to run anything, so
// a test that reached the install path would show it.
let osv;
let root;
let home;
let env;
let log;
before(async () => {
  if (!fishAvailable) return;
  osv = await startOsvStub();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-runnerfish-"));
  home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(home, ".safe-pnpm"), { recursive: true });
  fs.mkdirSync(bin);
  for (const f of fs.readdirSync(ASSETS)) {
    if (f.endsWith(".fish") || f === "malware-scan.js") {
      fs.copyFileSync(path.join(ASSETS, f), path.join(home, ".safe-pnpm", f));
    }
  }
  log = path.join(root, "calls.log");
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh
echo "npm $*" >> "${log}"
if [ "$1" = view ]; then
  case "$2" in
    unknown-*) echo "npm error code E404" >&2; exit 1 ;;
    broken-*) echo "npm error code ECONNRESET" >&2; exit 1 ;;
    *) echo '"1.2.3"'; exit 0 ;;
  esac
fi
`,
    { mode: 0o755 },
  );
  for (const name of ["npx", "pnpm", "yarn"]) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "RAN ${name} $*" >> "${log}"\n`,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\necho "DOCKER $*" >> "${log}"\nexit 1\n`,
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SAFE_PNPM_OSV_API: `${osv.url}/ok`,
  };
  delete env.SAFE_PNPM_OSV_STRICT;
  delete env.SAFE_PNPM_STRICT;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
});
after(() => {
  if (!fishAvailable) return;
  osv.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

// Sources the library and `wrapper` in fish, runs `line`, and reports exit,
// output and the stub log.
function run(wrapper, line, extraEnv = {}) {
  fs.writeFileSync(log, "");
  const script = `source "$HOME/.safe-pnpm/_safe_pkg_prescan.fish"
source "$HOME/.safe-pnpm/${wrapper}"
${line}`;
  const r = spawnSync("fish", ["--no-config", "-c", script], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: root,
  });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls: fs.readFileSync(log, "utf8"),
  };
}

test("fish: npx of a clean package checks it, then runs it", opts, () => {
  const r = run("npm-wrapper.fish", "npx cowsay hi");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /→ Malware scan \(OSV\)/);
  assert.match(r.out, /✓ 1 package checked against OSV; none known malicious/);
  assert.match(r.calls, /npm view cowsay version --json/);
  assert.match(r.calls, /RAN npx cowsay hi/);
});

test(
  "fish: npx of a known-malicious package is blocked and never runs",
  opts,
  () => {
    const r = run("npm-wrapper.fish", "npx mal-pkg");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /mal-pkg@1\.2\.3\s+MAL-2099-1/);
    assert.match(
      r.out,
      /✗ safe-pnpm: not running it; no package code was executed\./,
    );
    assert.doesNotMatch(r.out, /install blocked/);
    assert.doesNotMatch(r.calls, /RAN/);
  },
);

test(
  "fish: a malicious package passed with -p is blocked even when the command word is clean",
  opts,
  () => {
    const r = run("npm-wrapper.fish", "npx -p mal-pkg cowsay");
    assert.equal(r.status, 1, r.out);
    assert.doesNotMatch(r.calls, /RAN/);
  },
);

test(
  "fish: npm exec, pnpm dlx and yarn dlx are checked before they run",
  opts,
  () => {
    const n = run("npm-wrapper.fish", "npm exec mal-pkg");
    assert.equal(n.status, 1, n.out);
    assert.doesNotMatch(n.calls, /RAN|DOCKER/);
    const p = run("pnpm-wrapper.fish", "pnpm dlx mal-pkg");
    assert.equal(p.status, 1, p.out);
    assert.doesNotMatch(p.calls, /RAN|DOCKER/);
    const y = run("yarn-wrapper.fish", "yarn dlx mal-pkg");
    assert.equal(y.status, 1, y.out);
    assert.doesNotMatch(y.calls, /RAN|DOCKER/);
    const ok = run("pnpm-wrapper.fish", "pnpm dlx cowsay");
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.calls, /RAN pnpm dlx cowsay/);
    const yok = run("yarn-wrapper.fish", "yarn dlx cowsay");
    assert.equal(yok.status, 0, yok.out);
    assert.match(yok.calls, /RAN yarn dlx cowsay/);
  },
);

test(
  "fish: create commands check the create- package the manager would fetch",
  opts,
  () => {
    const p = run("pnpm-wrapper.fish", "pnpm create vite app");
    assert.equal(p.status, 0, p.out);
    assert.match(p.calls, /npm view create-vite version --json/);
    assert.match(p.calls, /RAN pnpm create vite app/);
    // The stub flags only names that start with mal-, which a create- package
    // never does, so these check what was looked up.
    const y = run("yarn-wrapper.fish", "yarn create react-app dir");
    assert.equal(y.status, 0, y.out);
    assert.match(y.calls, /npm view create-react-app version --json/);
    assert.match(y.calls, /RAN yarn create react-app dir/);
    const s = run("npm-wrapper.fish", "npm init @acme@2");
    assert.match(s.calls, /npm view @acme\/create@2 version --json/);
  },
);

test(
  "fish: a package the registry does not have is noted and the command still runs",
  opts,
  () => {
    const r = run("npm-wrapper.fish", "npx unknown-pkg");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /0 packages checked.*1 not checked/);
    assert.match(r.calls, /RAN npx unknown-pkg/);
  },
);

test("fish: a local path is not sent to npm view or OSV", opts, () => {
  const r = run("npm-wrapper.fish", "npx ./local-tool");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /npm view/);
  assert.match(r.calls, /RAN npx \.\/local-tool/);
});

test(
  "fish: an unreachable OSV warns and runs; strict mode blocks",
  opts,
  () => {
    const dead = { SAFE_PNPM_OSV_API: "http://127.0.0.1:1" };
    const warn = run("npm-wrapper.fish", "npx cowsay", dead);
    assert.equal(warn.status, 0, warn.out);
    assert.match(
      warn.out,
      /⚠️ {2}Malware scan could not run: could not reach OSV.*Continuing without it\./s,
    );
    assert.match(warn.calls, /RAN npx cowsay/);
    for (const flag of ["SAFE_PNPM_OSV_STRICT", "SAFE_PNPM_STRICT"]) {
      const strict = run("npm-wrapper.fish", "npx cowsay", {
        ...dead,
        [flag]: "1",
      });
      assert.equal(strict.status, 1, strict.out);
      assert.match(
        strict.out,
        new RegExp(
          `✗ Malware scan could not run: could not reach OSV.*Blocking \\(${flag}=1\\)`,
          "s",
        ),
      );
      assert.doesNotMatch(strict.calls, /RAN/);
    }
  },
);

test(
  "fish: a malformed or failed OSV response warns and runs; strict mode blocks",
  opts,
  () => {
    for (const mode of ["badjson", "http500", "short"]) {
      const api = { SAFE_PNPM_OSV_API: `${osv.url}/${mode}` };
      const warn = run("pnpm-wrapper.fish", "pnpm dlx cowsay", api);
      assert.equal(warn.status, 0, `${mode}: ${warn.out}`);
      assert.match(
        warn.out,
        /Malware scan could not run: .*Continuing without it\./s,
        mode,
      );
      assert.match(warn.calls, /RAN pnpm dlx cowsay/, mode);
      const strict = run("pnpm-wrapper.fish", "pnpm dlx cowsay", {
        ...api,
        SAFE_PNPM_OSV_STRICT: "1",
      });
      assert.equal(strict.status, 1, `${mode}: ${strict.out}`);
      assert.match(strict.out, /Blocking \(SAFE_PNPM_OSV_STRICT=1\)/, mode);
      assert.doesNotMatch(strict.calls, /RAN/, mode);
    }
  },
);

test(
  "fish: a failed version lookup counts as a scan failure, not a pass",
  opts,
  () => {
    const warn = run("npm-wrapper.fish", "npx broken-pkg");
    assert.equal(warn.status, 0, warn.out);
    assert.match(warn.out, /could not look up broken-pkg/);
    const strict = run("npm-wrapper.fish", "npx broken-pkg", {
      SAFE_PNPM_OSV_STRICT: "1",
    });
    assert.equal(strict.status, 1, strict.out);
    assert.doesNotMatch(strict.calls, /RAN/);
  },
);

test("fish: a missing scanner warns, and blocks under strict", opts, () => {
  const scanner = path.join(home, ".safe-pnpm", "malware-scan.js");
  const saved = path.join(root, "malware-scan.js.saved");
  fs.renameSync(scanner, saved);
  try {
    const warn = run("npm-wrapper.fish", "npx cowsay");
    assert.equal(warn.status, 0, warn.out);
    assert.match(
      warn.out,
      /Malware scan not installed.*Continuing without it/s,
    );
    const strict = run("npm-wrapper.fish", "npx cowsay", {
      SAFE_PNPM_OSV_STRICT: "1",
    });
    assert.equal(strict.status, 1, strict.out);
    assert.doesNotMatch(strict.calls, /RAN/);
  } finally {
    fs.renameSync(saved, scanner);
  }
});

test(
  "fish: commands that run no downloaded package skip the check",
  opts,
  () => {
    const r = run("npm-wrapper.fish", "npm run build");
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Malware scan/);
    assert.doesNotMatch(r.calls, /npm view/);
    assert.match(r.calls, /npm run build/);
  },
);

// The installed layout: setup copies the wrappers into ~/.config/fish/functions
// and fish autoloads each function from the file of its name, so npx and the
// helpers in _safe_pkg_prescan.fish must load with nothing sourced by hand.
function installFish(managers) {
  const fnDir = path.join(home, ".config", "fish", "functions");
  fs.rmSync(fnDir, { recursive: true, force: true });
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(path.join(__dirname, "..", "lib", "util", "shell.js"))}).addFishWrappers(${JSON.stringify(managers)}, null)`,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return fnDir;
}

function runInstalled(line, extraEnv = {}) {
  fs.writeFileSync(log, "");
  const r = spawnSync("fish", ["-c", line], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: root,
  });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls: fs.readFileSync(log, "utf8"),
  };
}

test(
  "fish: setup installs npx.fish next to npm.fish, and npx autoloads with the check",
  opts,
  () => {
    const fnDir = installFish(["pnpm", "npm"]);
    assert.deepEqual(fs.readdirSync(fnDir).sort(), [
      "_safe_pkg_prescan.fish",
      "npm.fish",
      "npx.fish",
      "pnpm.fish",
    ]);
    const bad = runInstalled("npx mal-pkg");
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /no package code was executed/);
    assert.doesNotMatch(bad.calls, /RAN/);
    const ok = runInstalled("npx cowsay");
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.calls, /RAN npx cowsay/);
    const dlx = runInstalled("pnpm dlx mal-pkg");
    assert.equal(dlx.status, 1, dlx.out);
    assert.doesNotMatch(dlx.calls, /RAN/);
  },
);

test(
  "fish: without the npm wrapper enabled, no npx function is installed",
  opts,
  () => {
    const fnDir = installFish(["pnpm"]);
    assert.deepEqual(fs.readdirSync(fnDir).sort(), [
      "_safe_pkg_prescan.fish",
      "pnpm.fish",
    ]);
  },
);

test(
  "fish: an autoloaded wrapper loads the helpers before its first call",
  opts,
  () => {
    // _safe_pkg_is_global runs before _safe_pkg_prescan in the wrapper, so it
    // only exists once the wrapper has loaded the library itself.
    installFish(["npm"]);
    const r = runInstalled("npm install -g left-pad");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /global installs are not supported/);
    assert.doesNotMatch(r.out, /Unknown command/);
    assert.doesNotMatch(r.calls, /DOCKER|RAN/);
  },
);

test(
  "fish: with the library missing, a wrapped command is refused, not run",
  opts,
  () => {
    const fnDir = installFish(["npm"]);
    fs.rmSync(path.join(fnDir, "_safe_pkg_prescan.fish"));
    for (const line of ["npx cowsay", "npm run build"]) {
      const r = runInstalled(line);
      assert.notEqual(r.status, 0, `${line}: ${r.out}`);
      assert.doesNotMatch(r.calls, /RAN|npm run/, line);
    }
  },
);
