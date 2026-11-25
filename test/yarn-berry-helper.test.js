const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LOCK,
  SAFE_LOCK,
  SAFE_V1_LOCK,
  SAFE_NPM_V1_LOCK,
  GITHUB_BLOCK,
  YARNRC,
  HOME_YARNRC,
  PKG,
  REFUSED,
} = require("./helpers/yarn-berry-fixtures");

// assets/yarn-berry-check.js holds the Yarn 2+ checks and the sandbox file
// steps of the PowerShell wrapper, which has no awk to run the bash ones
// with. The first half reads its answers on the fixtures of
// yarn-berry.test.js. The second half holds it to bash: the same verdict and
// the same words for every fixture, and the same bytes after the auth strip.
const HELPER = path.join(__dirname, "..", "assets", "yarn-berry-check.js");
const SHARED = path.join(__dirname, "..", "assets", "_safe_pkg_shared.sh");
const WIN = process.platform === "win32";
const hasBash =
  !WIN && spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

// What the wrapper's subcommand walk hands the checks for each command line
// in REFUSED. The bash half checks this against _safe_pkg_subcmd.
const SUBCMD = {
  install: "install",
  rebuild: "rebuild",
  "workspaces focus a": "focus",
  "link ../x": "link",
  "unlink x": "unlink",
  "set resolution ms@npm:2.1.1 npm:2.1.3": "setresolution",
  "version patch": "version",
  "pack --install-if-needed": "packinstall",
  "upgrade-interactive": "upgradeinteractive",
};

// Runs one helper mode the way the wrapper does: from the helper's own
// folder, every path absolute. Reads the answer strictly.
function helper(...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: path.dirname(HELPER),
    encoding: "utf8",
  });
  const lines = r.stdout.split("\n");
  const answer = { status: r.status, stdout: r.stdout, stderr: r.stderr };
  if (r.status !== 0 || lines.pop() !== "" || lines.pop() !== "end") {
    return answer;
  }
  answer.ok = lines[0] === "ok";
  assert.match(lines[0], /^(ok|refuse)$/, r.stdout);
  answer.members = [];
  for (const line of lines.slice(1)) {
    const m = /^(reason|spec|member) ([A-Za-z0-9+/=]*)$/.exec(line);
    assert.ok(m, `unreadable line ${JSON.stringify(line)}`);
    const text = Buffer.from(m[2], "base64").toString("utf8");
    if (m[1] === "member") answer.members.push(text);
    else answer[m[1]] = text;
  }
  return answer;
}

let work;
let n = 0;
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "safe-pnpm-ybh-"));
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

// A project the way yarn-berry.test.js lays one out: <dir> is the home
// folder, <dir>/proj the project root.
function project(o = {}) {
  const dir = path.join(work, String(n++));
  const proj = path.join(dir, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const ws = o.workspace ? { workspaces: ["packages/*"] } : {};
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ ...(o.pkg ?? PKG), ...ws }),
  );
  const yarnrc = o.yarnrc === undefined ? YARNRC : o.yarnrc;
  if (yarnrc !== null) fs.writeFileSync(path.join(proj, ".yarnrc.yml"), yarnrc);
  const lock = o.lock === undefined ? LOCK : o.lock;
  if (lock !== null) fs.writeFileSync(path.join(proj, "yarn.lock"), lock);
  const homeYarnrc = o.homeYarnrc === undefined ? HOME_YARNRC : o.homeYarnrc;
  if (homeYarnrc !== null) {
    fs.writeFileSync(path.join(dir, ".yarnrc.yml"), homeYarnrc);
  }
  if (o.workspace) {
    const a = path.join(proj, "packages", "a");
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(
      path.join(a, "package.json"),
      o.memberPkg ?? JSON.stringify({ name: "a", version: "1.0.0" }),
    );
  }
  return { dir, proj };
}

const PASSING = [
  ["the default project", {}],
  ["a lockfile with every supported source", { lock: SAFE_LOCK }],
  ["a migrated Yarn 1 lockfile", { lock: SAFE_V1_LOCK }],
  ["a migrated Yarn 1 lockfile npm wrote", { lock: SAFE_NPM_V1_LOCK }],
  ["nodeLinker: pnpm", { yarnrc: "nodeLinker: pnpm\n" }],
];
// "a host without node" is the wrapper's own answer, not the helper's.
const CHECKED = REFUSED.filter(([, opts]) => !opts.noNode);

test("check: a project that passes answers ok with the pin, and nothing else", () => {
  const { dir, proj } = project();
  const r = helper("check", proj, dir, "install");
  assert.equal(r.stdout, "ok\nspec eWFybkA0LjE4LjE=\nend\n");
  assert.equal(r.spec, PKG.packageManager);
});

for (const [name, opts] of PASSING) {
  test(`check: ${name} passes`, () => {
    const { dir, proj } = project(opts);
    const r = helper("check", proj, dir, "install");
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.spec, PKG.packageManager);
  });
}

for (const [name, opts, args, reason] of CHECKED) {
  test(`check: ${name} is refused`, () => {
    const sub = SUBCMD[args.join(" ")];
    assert.ok(sub, `no subcommand for ${args.join(" ")}`);
    const { dir, proj } = project(opts);
    const r = helper("check", proj, dir, sub);
    assert.equal(r.ok, false, r.stdout);
    assert.match(r.reason, reason);
    assert.equal(r.spec, undefined, "a refusal carries no pin to run");
  });
}

test("check: the reason for a pin with control characters has none", () => {
  const { dir, proj } = project({
    pkg: { ...PKG, packageManager: "yarn@4\u009b2J\u001b]0;x\u0007" },
  });
  const r = helper("check", proj, dir, "install");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an exact Yarn version/);
  assert.match(r.reason, /^[ -~]*$/);
});

for (const [name, args] of [
  ["no mode", []],
  ["an unknown mode", ["nope", "x"]],
  ["a mode named like an object member", ["constructor", "x"]],
  ["too few arguments", ["check", "x", "y"]],
  ["too many arguments", ["strip", "x", "y"]],
  ["an empty argument", ["check", "x", "", "install"]],
]) {
  test(`${name} prints the usage line, exits 2 and answers nothing`, () => {
    const r = helper(...args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^usage: yarn-berry-check\.js /);
  });
}

test("a mode that fails answers refuse with the failure, not half an answer", () => {
  const dir = path.join(work, String(n++));
  fs.mkdirSync(dir);
  const r = helper("snapshot", dir, dir);
  assert.equal(r.status, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^the Yarn 2\+ helper failed \(snapshot\): /);
});

// Folder names a shell splits, trims or reads as a flag. Windows cannot
// create the last two.
const MEMBERS = WIN ? ["a b", "-x"] : ["a b", "-x", "a ", "new\nline"];

// One project through the four file steps.
function staged(osName, cpu, yarnrc) {
  const { dir, proj } = project({
    workspace: true,
    yarnrc,
    homeYarnrc: 'npmAuthToken: "HOME-SECRET"\nenableTelemetry: false',
  });
  for (const m of MEMBERS) {
    fs.mkdirSync(path.join(proj, "packages", m));
    fs.writeFileSync(path.join(proj, "packages", m, "package.json"), "{}");
  }
  fs.mkdirSync(path.join(proj, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "node_modules", "dep", "package.json"),
    "{}",
  );
  for (const d of [".corepack/v1", ".safe-home", ".safe-store/x"]) {
    fs.mkdirSync(path.join(proj, d), { recursive: true });
    fs.writeFileSync(path.join(proj, d, "package.json"), "{}");
  }
  fs.writeFileSync(path.join(proj, ".npmrc"), "//r.example/:_authToken=T\n");
  const patches = path.join(proj, ".yarn", "patches");
  fs.mkdirSync(patches, { recursive: true });
  for (const f of ["ms.patch", "notes.txt", ".hidden.patch"]) {
    fs.writeFileSync(path.join(patches, f), "x\n");
  }
  const tmp = path.join(dir, "tmp");
  const snap = path.join(dir, "snap");
  for (const d of [tmp, snap]) fs.mkdirSync(d);
  return {
    dir,
    proj,
    tmp,
    snap,
    r: helper("stage", proj, dir, tmp, snap, osName, cpu),
  };
}
const RC_AUTH = `${YARNRC}npmAuthToken: "RC-SECRET"\nnpmRegistryServer: "https://u:PASS@npm.acme.example"\n`;
const ALL_MEMBERS = ["a", ...MEMBERS].map((m) => `packages/${m}`).sort();

test("stage: the manifests, the rc files, the patches and every member reach the sandbox", () => {
  const { proj, tmp, snap, r } = staged("-", "-", RC_AUTH);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([...r.members].sort(), ALL_MEMBERS);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(snap, "members.json"), "utf8")).sort(),
    ALL_MEMBERS,
  );
  for (const f of ["package.json", "yarn.lock", ".npmrc", ".yarnrc.yml"]) {
    assert.deepEqual(
      fs.readFileSync(path.join(tmp, f)),
      fs.readFileSync(path.join(proj, f)),
      f,
    );
  }
  for (const m of ALL_MEMBERS) {
    assert.ok(
      fs.existsSync(path.join(tmp, m, "package.json")),
      JSON.stringify(m),
    );
  }
  assert.deepEqual(
    fs.readdirSync(path.join(tmp, "packages")).sort(),
    ALL_MEMBERS.map((m) => m.slice("packages/".length)),
  );
  assert.deepEqual(fs.readdirSync(path.join(tmp, ".yarn", "patches")), [
    "ms.patch",
  ]);
  assert.deepEqual(
    fs.readdirSync(tmp).sort(),
    [
      ".npmrc",
      ".safe-home",
      ".yarn",
      ".yarnrc.yml",
      "package.json",
      "packages",
      "yarn.lock",
    ],
    "node_modules and the sandbox's own folders are not copied in",
  );
  assert.deepEqual(fs.readdirSync(path.join(tmp, ".safe-home")), [
    ".yarnrc.yml",
  ]);
});

test("stage: the sandbox ~/.yarnrc.yml is the user's, then the GitHub block on its own line", () => {
  const { dir, tmp } = staged("-", "-", RC_AUTH);
  assert.equal(
    fs.readFileSync(path.join(tmp, ".safe-home", ".yarnrc.yml"), "utf8"),
    `npmAuthToken: "HOME-SECRET"\nenableTelemetry: false\n${GITHUB_BLOCK}`,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, ".yarnrc.yml"), "utf8"),
    'npmAuthToken: "HOME-SECRET"\nenableTelemetry: false',
    "the real one is not touched",
  );
});

for (const [osName, cpu] of [
  ["darwin", "arm64"],
  ["win32", "x64"],
]) {
  test(`stage: a ${osName} ${cpu} host adds supportedArchitectures to the sandbox copy only`, () => {
    const { proj, tmp } = staged(osName, cpu, YARNRC);
    assert.equal(
      fs.readFileSync(path.join(tmp, ".yarnrc.yml"), "utf8"),
      `${YARNRC}supportedArchitectures:\n  os:\n    - current\n    - ${osName}\n  cpu:\n    - current\n    - ${cpu}\n`,
    );
    assert.equal(
      fs.readFileSync(path.join(proj, ".yarnrc.yml"), "utf8"),
      YARNRC,
    );
  });
}

for (const [osName, cpu, yarnrc, why] of [
  ["-", "-", YARNRC, "a Linux host"],
  ["darwin", "ppc", YARNRC, "an unknown cpu"],
  ["linux", "x64", YARNRC, "an os the image already builds for"],
  [
    "darwin",
    "arm64",
    `${YARNRC}supportedArchitectures:\n  os: [linux]\n`,
    "a project with its own",
  ],
]) {
  test(`stage: ${why} leaves supportedArchitectures alone`, () => {
    const { tmp } = staged(osName, cpu, yarnrc);
    assert.equal(
      fs.readFileSync(path.join(tmp, ".yarnrc.yml"), "utf8"),
      yarnrc,
    );
  });
}

test("snapshot, strip and restore: the fetch's manifests come back, the auth does not reach the build", () => {
  const { proj, tmp, snap, r } = staged("-", "-", RC_AUTH);
  assert.equal(r.ok, true, r.reason);
  // What the fetch phase leaves.
  const fetched = (f) => `fetched ${f}`;
  const rels = [
    "package.json",
    "yarn.lock",
    ...ALL_MEMBERS.map((m) => `${m}/package.json`),
  ];
  for (const f of rels) fs.writeFileSync(path.join(tmp, f), fetched(f));
  assert.equal(helper("snapshot", tmp, snap).ok, true);
  assert.equal(helper("strip", tmp).ok, true);
  const rcOut = fs.readFileSync(path.join(tmp, ".yarnrc.yml"), "utf8");
  assert.doesNotMatch(rcOut, /SECRET|PASS|npmAuth/);
  assert.match(rcOut, /^npmRegistryServer: "https:\/\/npm\.acme\.example"\n/m);
  assert.match(rcOut, /^nodeLinker: node-modules\n/, "the other settings stay");
  assert.equal(
    fs.readFileSync(path.join(tmp, ".safe-home", ".yarnrc.yml"), "utf8"),
    `enableTelemetry: false\n${GITHUB_BLOCK}`,
  );
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.endsWith(".clean")),
    [],
  );
  // What the build phase may do to the sandbox.
  for (const f of rels) fs.writeFileSync(path.join(tmp, f), "evil");
  assert.equal(helper("restore", snap, proj).ok, true);
  for (const f of rels) {
    assert.equal(fs.readFileSync(path.join(proj, f), "utf8"), fetched(f), f);
  }
  assert.equal(
    fs.readFileSync(path.join(proj, ".yarnrc.yml"), "utf8"),
    RC_AUTH,
  );
});

test("strip: a file it cannot read as printable ASCII stops the build, and leaves no half-written copy", () => {
  const { tmp, r } = staged("-", "-", `${YARNRC}# café\n`);
  assert.equal(r.ok, true, r.reason);
  const s = helper("strip", tmp);
  assert.equal(s.ok, false);
  assert.match(
    s.reason,
    /could not remove the registry credentials from .*\.yarnrc\.yml; the build phase did not run\./,
  );
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.endsWith(".clean")),
    [],
  );
});

test("stage: a member package.json that cannot be copied fails the run by name", {
  skip: WIN || process.getuid() === 0 ? "needs file modes" : false,
}, () => {
  const { dir, proj } = project({ workspace: true });
  fs.chmodSync(path.join(proj, "packages", "a", "package.json"), 0o000);
  const tmp = path.join(dir, "tmp");
  const snap = path.join(dir, "snap");
  for (const d of [tmp, snap]) fs.mkdirSync(d);
  const r = helper("stage", proj, dir, tmp, snap, "-", "-");
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "could not copy packages/a/package.json into the sandbox; nothing was installed.",
  );
});

// bash and the helper on the same files.
const bashSkip = hasBash ? false : "bash not available";
let cases;
function bashRun() {
  if (cases) return cases;
  cases = [
    ...PASSING.map(([name, opts]) => [name, opts, ["install"]]),
    ...CHECKED,
  ].map(([name, opts, args]) => ({ name, args, ...project(opts) }));
  for (const c of cases) {
    fs.writeFileSync(path.join(c.dir, "args"), args(c.args));
  }
  const driver = path.join(work, "driver.sh");
  fs.writeFileSync(
    driver,
    `. "$1"; shift
for d in "$@"; do
  a=()
  while IFS= read -r line; do a+=("$line"); done < "$d/args"
  export HOME="$d"
  cd "$d/proj" || exit 9
  _safe_pkg_subcmd yarn "\${a[@]}" > "$d/sub"
  _safe_pkg_yarn_berry_check "$d/proj" "\${a[@]}" > "$d/bash.out" 2> "$d/bash.err"
  echo $? > "$d/bash.rc"
  mkdir -p "$d/bash-strip/.safe-home"
  for f in .yarnrc.yml .safe-home/.yarnrc.yml; do
    src="$d/proj/$f"
    [ "$f" = .yarnrc.yml ] || src="$d/.yarnrc.yml"
    [ -f "$src" ] || continue
    cp "$src" "$d/bash-strip/$f"
    _safe_pkg_strip_yarnrc_yml_auth "$d/bash-strip/$f" 2>/dev/null
  done
done
`,
  );
  const r = spawnSync("bash", [driver, SHARED, ...cases.map((c) => c.dir)], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return cases;
}
const args = (a) => a.map((x) => `${x}\n`).join("");

test("the subcommand names in this file are the ones bash's walk prints", {
  skip: bashSkip,
}, () => {
  for (const c of bashRun()) {
    assert.equal(
      fs.readFileSync(path.join(c.dir, "sub"), "utf8").trim(),
      SUBCMD[c.args.join(" ")],
      c.name,
    );
  }
});

test("bash and the helper give the same verdict in the same words for every fixture", {
  skip: bashSkip,
}, () => {
  let refusedCount = 0;
  for (const c of bashRun()) {
    const bashRefused =
      fs.readFileSync(path.join(c.dir, "bash.rc"), "utf8").trim() === "0";
    const bashOut = fs
      .readFileSync(path.join(c.dir, "bash.out"))
      .toString("latin1")
      .replace(/\n+$/, "");
    const r = helper("check", c.proj, c.dir, SUBCMD[c.args.join(" ")]);
    assert.equal(
      r.ok,
      !bashRefused,
      `${c.name}: bash says ${bashOut || "pass"}`,
    );
    if (!bashRefused) continue;
    refusedCount++;
    assert.equal(
      Buffer.from(r.reason, "utf8").toString("latin1"),
      bashOut,
      c.name,
    );
  }
  assert.equal(
    refusedCount,
    CHECKED.length,
    "every REFUSED fixture is refused by bash",
  );
});

test("bash and the helper strip the auth from the .yarnrc.yml files to the same bytes", {
  skip: bashSkip,
}, () => {
  let compared = 0;
  for (const c of bashRun()) {
    const tmp = path.join(c.dir, "helper-strip");
    fs.mkdirSync(path.join(tmp, ".safe-home"), { recursive: true });
    const files = [];
    for (const [rel, src] of [
      [".yarnrc.yml", path.join(c.proj, ".yarnrc.yml")],
      [path.join(".safe-home", ".yarnrc.yml"), path.join(c.dir, ".yarnrc.yml")],
    ]) {
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(tmp, rel));
      files.push(rel);
    }
    const odd = files.some((rel) =>
      fs.readFileSync(path.join(tmp, rel)).some((b) => b === 0 || b > 127),
    );
    const s = helper("strip", tmp);
    // awk flavors read these bytes differently, so the helper stops instead.
    assert.equal(s.ok, !odd, `${c.name}: ${s.reason}`);
    if (odd) continue;
    for (const rel of files) {
      assert.deepEqual(
        fs.readFileSync(path.join(tmp, rel)),
        fs.readFileSync(path.join(c.dir, "bash-strip", rel)),
        `${c.name}: ${rel}`,
      );
      compared++;
    }
  }
  assert.ok(compared >= CHECKED.length, `only ${compared} files compared`);
});
