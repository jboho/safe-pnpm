#!/usr/bin/env node
// Host-side checks and sandbox file staging for Yarn 2+ (Berry) projects, for
// the PowerShell wrapper. A port of the Berry functions in
// _safe_pkg_shared.sh (_safe_pkg_yarn_berry_check and what it calls, the
// member copy, the snapshot, _safe_pkg_strip_yarnrc_yml_auth and
// _safe_pkg_yarn_berry_arch): Windows has no awk. test/yarn-berry-helper.test.js
// runs both on the same files and compares the answers, so change them together.
//
// Usage: node yarn-berry-check.js <mode> <args...>
//   check    <root> <home> <subcommand>
//   stage    <root> <home> <tmpdir> <snapdir> <os|-> <cpu|->
//   snapshot <tmpdir> <snapdir>
//   strip    <tmpdir>
//   restore  <snapdir> <root>
// Prints "ok" or "refuse", then "reason|spec|member <base64 of UTF-8>" lines,
// then "end". Exit 0 means the answer is complete; anything else, or output
// without "end", must be read as a refusal.
"use strict";
const fs = require("fs");
const path = require("path");

// awk and grep run under LC_ALL=C there: one character per byte, [[:space:]]
// is these six, and tolower touches A-Z only.
const SP = "[ \\t\\n\\v\\f\\r]";
const bytes = (f) => fs.readFileSync(f, "latin1");
const lower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
// awk records: a final newline ends the last line, it does not start another.
const records = (text) => {
  const a = text.split("\n");
  if (a[a.length - 1] === "") a.pop();
  return a;
};
const noCr = (l) => l.replace(/\r$/, "");
const safe = (s) => String(s).replace(/[^ -~]/g, "?");

function yarnrcSet(f, key) {
  if (!isFile(f)) return false;
  const re = new RegExp(`^["']?${key}["']?${SP}*:`);
  return records(bytes(f)).some((l) => re.test(l));
}

function yarnrcPlain(f) {
  if (!isFile(f)) return 0;
  const text = bytes(f);
  if (text.includes("\0")) return 1;
  const blank = new RegExp(`^${SP}*($|#)`);
  const key = new RegExp(`^[A-Za-z][A-Za-z0-9]*${SP}*:`);
  let started = false;
  const rs = records(text);
  for (let i = 0; i < rs.length; i++) {
    const l = noCr(rs[i]);
    if (/[^\t -~]/.test(l)) return i + 1;
    if (blank.test(l)) continue;
    if (/^ /.test(l)) {
      if (started) continue;
      return i + 1;
    }
    if (key.test(l)) {
      started = true;
      continue;
    }
    return i + 1;
  }
  return 0;
}

function yarnrcInterp(f) {
  if (!isFile(f)) return 0;
  const auth = new RegExp(`^${SP}*(npmAuthToken|npmAuthIdent)${SP}*:`);
  const rs = records(bytes(f));
  for (let i = 0; i < rs.length; i++) {
    if (/\$\{|\\/.test(rs[i]) && !auth.test(rs[i])) return i + 1;
  }
  return 0;
}

// Two different files must never read as one (that skips the check), so a
// filesystem without file ids answers no.
function sameFile(a, b) {
  if (a === b) return true;
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

class Bad {
  constructor(code) {
    this.code = code;
  }
}

function netCheck(root, home) {
  const proj = root + path.sep + ".yarnrc.yml";
  const homeRc = home + path.sep + ".yarnrc.yml";
  if (!isFile(proj)) return "";
  const hasHome = isFile(homeRc);
  if (hasHome && sameFile(proj, homeRc)) return "";
  const keyre = /^[A-Za-z][A-Za-z0-9]*[ \t]*:/;
  const scopere = /^("[^"\\]*"|'[^']*'|[A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*:/;
  const net =
    /^(npmRegistryServer|npmAuditRegistry|httpProxy|httpsProxy|enableStrictSsl|caFilePath|httpsCaFilePath|httpsCertFilePath|httpsKeyFilePath)$/;
  const H = new Set();
  const P = [];
  let ishome = false;
  const bad = (n) => {
    throw new Bad(`U ${ishome ? "H" : "P"} ${n}`);
  };
  const empty = (s) => {
    s = s.replace(/^[ \t]+/, "");
    return s === "" || s.startsWith("#");
  };
  const val = (s, n) => {
    s = s.replace(/^[ \t]+/, "");
    if (empty(s)) bad(n);
    const q = s[0];
    let v;
    if (q === '"' || q === "'") {
      let rest = s.slice(1);
      const k = rest.indexOf(q);
      if (k < 0) bad(n);
      v = rest.slice(0, k);
      rest = rest.slice(k + 1);
      if (!/^([ \t]+#.*)?[ \t]*$/s.test(rest) || (q === '"' && v.includes("\\"))) bad(n);
    } else {
      if ("-?:,[]{}#&*!|>%@`".includes(q)) bad(n);
      v = s.replace(/[ \t]#.*/s, "").replace(/[ \t]+$/, "");
      if (v.includes(": ") || v.endsWith(":")) bad(n);
    }
    if (/[^!-~]/.test(v)) bad(n);
    return v;
  };
  const norm = (v) => {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(v);
    if (m) {
      const s = m[0];
      let a = v.slice(s.length);
      let r = "";
      const k = a.search(/[/\\?#]/);
      if (k >= 0) {
        r = a.slice(k);
        a = a.slice(0, k);
      }
      a = a.replace(/.*@/s, "");
      v = lower(s + a) + r;
    }
    return v.replace(/\/+$/, "");
  };
  const rec = (p, v, n) => {
    v = norm(v);
    if (ishome) H.add(`${p}\n${v}`);
    else P.push([p, v, n]);
  };
  let out = "";
  try {
    for (const file of hasHome ? [homeRc, proj] : [proj]) {
      ishome = file === homeRc && hasHome;
      let blk = false;
      let chk = -1;
      let chkn = 0;
      let i1 = 0;
      let i2 = 0;
      let scope = "";
      let inval = false;
      const rs = records(bytes(file));
      for (let i = 0; i < rs.length; i++) {
        const fnr = i + 1;
        const l = noCr(rs[i]);
        if (/^[ \t]*$/.test(l)) continue;
        const ind = /^[ \t]*/.exec(l)[0].length;
        const line = l.slice(ind);
        if (chk >= 0) {
          if (ind > chk) bad(chkn);
          chk = -1;
        }
        if (line.startsWith("#")) continue;
        if (ind === 0) {
          blk = false;
          const m = keyre.exec(line);
          if (!m) continue;
          const key = m[0].replace(/[ \t]*:$/, "");
          const rest = line.slice(m[0].length);
          if (key === "npmScopes") {
            if (!empty(rest)) bad(fnr);
            blk = true;
            i1 = 0;
            scope = "";
          } else if (net.test(key)) {
            rec(key, val(rest, fnr), fnr);
            chk = 0;
            chkn = fnr;
          }
          continue;
        }
        if (!blk) continue;
        if (l.slice(0, ind).includes("\t")) bad(fnr);
        if (!i1) i1 = ind;
        if (ind === i1) {
          const m = scopere.exec(line);
          if (!m) bad(fnr);
          scope = m[0].replace(/[ \t]*:$/, "").replace(/^["']|["']$/g, "");
          if (scope === "" || /[^!-~]/.test(scope) || !empty(line.slice(m[0].length))) bad(fnr);
          i2 = 0;
          inval = false;
          continue;
        }
        if (ind < i1 || scope === "") bad(fnr);
        if (!i2) i2 = ind;
        if (ind > i2) {
          if (inval) continue;
          bad(fnr);
        }
        const m = keyre.exec(line);
        if (ind < i2 || !m) bad(fnr);
        const key = m[0].replace(/[ \t]*:$/, "");
        inval = key !== "npmRegistryServer";
        if (!inval) {
          rec(`npmScopes.${scope}.${key}`, val(line.slice(m[0].length), fnr), fnr);
          chk = i2;
          chkn = fnr;
        }
      }
    }
    for (const [p, v, n] of P) {
      const registry = p === "npmRegistryServer" || /^npmScopes\..*\.npmRegistryServer$/s.test(p);
      if (registry && (v === "https://registry.yarnpkg.com" || v === "https://registry.npmjs.org")) continue;
      if (p === "enableStrictSsl" && v === "true") continue;
      if (H.has(`${p}\n${v}`)) continue;
      return `${proj} sets ${p} to ${v}, which is not the value in ${homeRc}. The fetch phase has the registry token, and Yarn could send it to a registry or proxy the project picked. If you trust that server, add the same setting (line ${n}) to ${homeRc} and run the command again.`;
    }
  } catch (e) {
    out = e instanceof Bad ? e.code : "U P 1";
  }
  if (!out) return "";
  const f = out.startsWith("U H ") ? homeRc : proj;
  return `${f} has a registry or proxy setting the wrapper cannot read safely (line ${out.slice(out.lastIndexOf(" ") + 1)}): write it as key: value on one line, with a plain or quoted value and no anchors, aliases, tags, braces or multi-line text, and run the command again.`;
}

// The folders (relative to root, with /) that hold a package.json below the
// root: what `find . -mindepth 2 -name package.json` prints there, without
// node_modules and the sandbox's own folders. Symlinks are not followed.
function members(root) {
  const out = [];
  const own = new Set([".yarn", ".corepack", ".safe-home", ".safe-store"]);
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "package.json" && depth >= 1) out.push(rel);
      if (e.isDirectory() && e.name !== "node_modules" && !(depth === 0 && own.has(e.name))) {
        walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  };
  walk("", 0);
  return out;
}

function manifestCheck(root) {
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"];
  for (const rel of ["package.json", ...members(root).map((m) => `${m}/package.json`)]) {
    const p = safe(rel);
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch {
      m = undefined;
    }
    if (!m || typeof m !== "object") {
      return `${p} is not valid JSON, so the wrapper cannot check its dependencies. Fix the file and run the command again.`;
    }
    for (const k of fields) {
      for (const [n, v] of Object.entries(m[k] ?? {})) {
        if (/exec(:|%3a)/i.test(String(v))) {
          return `${p} depends on ${safe(n)} through exec:, which the wrapper does not support: Yarn runs its script while it fetches, when the registry token is still available.`;
        }
      }
    }
    for (const [n, v] of Object.entries(m.dependenciesMeta ?? {})) {
      if (v && typeof v === "object" && "built" in v && v.built !== false) {
        return `${p} sets dependenciesMeta.${safe(n)}.built, which the wrapper does not support: it lets Yarn run an exec: dependency script while it fetches, when the registry token is still available. Remove the setting and run the command again.`;
      }
    }
  }
  return "";
}

function origins(home) {
  let o = " https://registry.npmjs.org https://registry.yarnpkg.com ";
  let rs = [];
  try {
    rs = records(bytes(home + path.sep + ".yarnrc.yml"));
  } catch {
    rs = [];
  }
  const re = /^[ \t]*["']?npmRegistryServer["']?[ \t]*:[ \t]*/;
  for (const raw of rs) {
    const l = noCr(raw);
    const m = re.exec(l);
    if (!m) continue;
    const v = lower(
      l
        .slice(m[0].length)
        .replace(/[ \t]+#.*/s, "")
        .replace(/[ \t]+$/, "")
        .replace(/^["']|["']$/g, ""),
    );
    const u = /^https?:\/\/[^/?#\\]*/.exec(v);
    if (!u) continue;
    const s = u[0].slice(0, u[0].indexOf("//") + 2);
    const a = u[0].slice(s.length).replace(/.*@/s, "");
    if (/^[a-z0-9.-]+(:[0-9]+)?$/.test(a)) o += `${s}${a} `;
  }
  return o;
}

// "" when the lockfile passes, or "G <line>", "S <resolution>", "A <resolution>".
function lockCheck(f, trustedOrigins) {
  if (!isFile(f)) return "";
  let text;
  try {
    text = bytes(f);
  } catch {
    return "G 1";
  }
  if (text.includes("\0")) return "G 1";
  const hx = "0123456789abcdef";
  const dec = (u) => {
    let out = "";
    let i;
    while ((i = u.indexOf("%")) >= 0) {
      const c = lower(u.substr(i + 1, 2));
      if (!/^[0-9a-f][0-9a-f]$/.test(c)) return "";
      const n = hx.indexOf(c[0]) * 16 + hx.indexOf(c[1]);
      if (n < 33 || n > 126) return "";
      out += u.slice(0, i) + String.fromCharCode(n);
      u = u.slice(i + 3);
    }
    return out + u;
  };
  const trusted = (u) => {
    if (/[^!-~]/.test(u)) return false;
    u = lower(u);
    const m = /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?/.exec(u);
    if (!m) return false;
    const rest = u.slice(m[0].length);
    if (rest !== "" && !rest.startsWith("/")) return false;
    return trustedOrigins.includes(` ${m[0]} `);
  };
  const archok = (r) => {
    const i = r.indexOf("::__archiveUrl=");
    return i < 0 ? true : trusted(dec(r.slice(i + 15)));
  };
  const urlok = (u) => {
    if (!/^https?:\/\//.test(u)) return false;
    const h = lower(
      u
        .slice(u.indexOf("//") + 2)
        .replace(/[/?#].*/s, "")
        .replace(/.*@/s, "")
        .replace(/:[0-9]*$/, "")
        .replace(/\.+$/, ""),
    );
    if (h === "" || h.includes("%") || h === "github.com" || h.endsWith(".github.com")) return false;
    return !lower(u.replace(/#.*/s, "")).endsWith(".git");
  };
  const srcok = (r) => {
    const m = (r.startsWith("@") ? /^@[^/@]+\/[^@]+@/ : /^[^@]+@/).exec(r);
    if (!m) return false;
    const s = r.slice(m[0].length);
    if (s.startsWith("npm:")) return /^[0-9A-Za-z.+-]+(::__archiveUrl=[A-Za-z0-9%._~-]+)?$/.test(s.slice(4));
    if (/^(workspace|file|portal|link):/.test(s)) return true;
    if (s.startsWith("patch:")) {
      return /^(@[^/@]+\/)?[^@/]+@(npm%3[Aa]([0-9A-Za-z.-]|%2[Bb])+|workspace%3[Aa][^#]*)(#|$)/.test(s.slice(6));
    }
    return urlok(s);
  };
  const valok = (v) =>
    /^"[^"]*"$/.test(v) || (/^[A-Za-z0-9._/~^<=+]/.test(v) && !v.includes(" #") && !v.includes(": ") && !v.endsWith(":"));
  const unq = (v) => (v.startsWith('"') ? v.substr(1, v.length - 2) : v);
  let lead = true;
  let v1 = false;
  let started = false;
  let pind = 0;
  let pnov = false;
  let dep = false;
  let nov = false;
  const rs = records(text);
  for (let i = 0; i < rs.length; i++) {
    const G = `G ${i + 1}`;
    const l = noCr(rs[i]);
    if (/[^ -~]/.test(l) || l.includes("\\")) return G;
    if (lead && l.startsWith("#")) {
      if (/^# +yarn +lockfile +v1$/.test(lower(l))) v1 = true;
      continue;
    }
    lead = false;
    if (/^ *$/.test(l) || l.startsWith("#")) continue;
    const ind = /^ */.exec(l)[0].length;
    const line = l.slice(ind);
    if (!started && ind !== 0) return G;
    if (started && ind > pind && !(pnov && ind === pind + 2)) return G;
    if (v1) {
      if (ind === 0) {
        if (!/^("[^"]*"|[^ ",:#][^ ",:]*)(, ("[^"]*"|[^ ",:]+))*:$/.test(line) || line.includes("__metadata")) return G;
        dep = false;
        nov = true;
      } else if (ind === 2) {
        const m = /^("(version|resolved|integrity|uid)"|version|resolved|integrity|uid) /.exec(line);
        if (/^"?(dependencies|optionalDependencies)"?:$/.test(line)) {
          dep = true;
          nov = true;
        } else if (m) {
          const key = unq(line.slice(0, m[0].length - 1));
          let val = line.slice(m[0].length);
          if (!/^("[^"]*"|[^ "]+)$/.test(val)) return G;
          if (key === "resolved") {
            val = unq(val);
            if (!urlok(val) && !/^[^/:]+\.tgz(#.*)?$/s.test(val)) return `S ${val}`;
            if (urlok(val) && !trusted(val)) return `A ${val}`;
          }
          dep = false;
          nov = false;
        } else return G;
      } else if (ind === 4 && dep && /^("[^"]*"|[^ "]+) ("[^"]*"|[^ "]+)$/.test(line)) nov = false;
      else return G;
    } else if (ind === 0) {
      if (line !== "__metadata:" && !/^"[^"]*":$/.test(line)) return G;
      nov = true;
    } else {
      let re;
      if (ind === 2 || ind === 6) re = /^[A-Za-z]+:/;
      else if (ind === 4) re = /^("[^"]*"|[A-Za-z0-9][A-Za-z0-9._-]*):/;
      else return G;
      const m = re.exec(line);
      if (!m) return G;
      const key = line.slice(0, m[0].length - 1);
      let val = line.slice(m[0].length);
      if (val === "") nov = true;
      else if (!val.startsWith(" ") || !valok(val.slice(1))) return G;
      else {
        nov = false;
        val = val.slice(1);
      }
      if (ind === 2 && key === "resolved") return G;
      if (ind === 2 && key === "resolution") {
        if (nov) return G;
        if (!srcok(unq(val))) return `S ${unq(val)}`;
        if (!archok(unq(val))) return `A ${unq(val)}`;
      }
    }
    pind = ind;
    pnov = nov;
    started = true;
  }
  return "";
}

const PIN = /^yarn@([3-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.]+)?$/;

// The packageManager value as _safe_pkg_yarn_berry_pin reads it: the first
// match in the file, never across a line.
function pin(root) {
  let text;
  try {
    text = bytes(root + path.sep + "package.json");
  } catch {
    return "";
  }
  const m = /"packageManager"[ \t\v\f\r]*:[ \t\v\f\r]*"[^"\n]*"/.exec(text);
  if (!m) return "";
  return m[0].replace(new RegExp(`.*:${SP}*"`, "s"), "").replace(/"$/, "");
}

const SUBCOMMANDS = {
  rebuild:
    "yarn rebuild is not supported through the wrapper: it runs package build scripts outside an install, and the sandbox runs them only in the offline phase of one.",
  focus:
    "yarn workspaces focus is not supported through the wrapper: it has no fetch-only mode, so the sandbox cannot fetch with the network on and build with it off.",
  link: "yarn link is not supported through the wrapper: in a Yarn 2+ project it changes package.json and runs an install outside the sandbox's two phases. Edit the portal: or link: dependency in package.json, then run yarn install.",
  unlink:
    "yarn unlink is not supported through the wrapper: in a Yarn 2+ project it changes package.json and runs an install outside the sandbox's two phases. Edit the portal: or link: dependency in package.json, then run yarn install.",
  setresolution:
    "yarn set resolution is not supported through the wrapper: it rewrites yarn.lock and runs an install outside the sandbox's two phases. Add the resolution to the resolutions field of package.json, then run yarn install.",
  version:
    "yarn version is not supported through the wrapper: it changes package.json and runs an install outside the sandbox's two phases. Change the version in package.json, then run yarn install. yarn version check still runs.",
  packinstall:
    "yarn pack --install-if-needed is not supported through the wrapper: it runs an install outside the sandbox's two phases. Run yarn install first, then yarn pack.",
  upgradeinteractive:
    "yarn upgrade-interactive is not supported through the wrapper: it asks questions, and the sandbox runs Yarn without a terminal. Use yarn up with the versions you want.",
};

// Why the wrapper will not run this command in the Yarn 2+ project at root,
// or the corepack spec to run it with. Same order as _safe_pkg_yarn_berry_check.
function check(root, home, sub) {
  const no = (reason) => ({ ok: false, reason });
  if (Object.prototype.hasOwnProperty.call(SUBCOMMANDS, sub)) return no(SUBCOMMANDS[sub]);
  const pkg = root + path.sep + "package.json";
  const spec = pin(root);
  if (!PIN.test(spec)) {
    const pm = spec.replace(/[^ -~]/g, "");
    if (/^yarn@[0-2](\..*)?$/s.test(pm)) {
      return no(
        `${pkg} pins ${pm.split("+")[0]}, and the wrapper supports Yarn 3 or later: older releases cannot fetch without running build scripts (--mode=skip-build).`,
      );
    }
    if (pm.startsWith("yarn@")) {
      return no(
        `${pkg} pins ${pm}, which is not an exact Yarn version, and the sandbox runs exactly the pinned release through corepack. Pin an exact version (yarn set version stable writes one) and run the command again.`,
      );
    }
    return no(
      `${pkg} does not pin a Yarn version with packageManager, and the sandbox runs the pinned Yarn through corepack. Add the pin (yarn set version stable does) and run the command again.`,
    );
  }
  const projRc = root + path.sep + ".yarnrc.yml";
  const rcs = [projRc, home + path.sep + ".yarnrc.yml"];
  for (const f of rcs) {
    let n = yarnrcPlain(f);
    if (n) {
      return no(
        `${f} has a line the wrapper cannot read safely (line ${n}): write each top-level setting as a plain name at the start of a line (key: value), not quoted, in braces or indented, use only printable ASCII and tabs, and run the command again.`,
      );
    }
    if (f === projRc && (n = yarnrcInterp(f))) {
      return no(
        `${f} reads an environment variable or an escape (line ${n}), which the wrapper allows only in npmAuthToken and npmAuthIdent: Yarn fills \${VAR} in any setting, so a path setting could write the registry token into the project.`,
      );
    }
    if (yarnrcSet(f, "plugins")) {
      return no(
        `${f} lists plugins, which the wrapper does not support: a plugin is code that runs inside Yarn while the registry token is available.`,
      );
    }
    if (yarnrcSet(f, "lockfileFilename")) {
      return no(
        `${f} sets lockfileFilename, so Yarn would write the lockfile somewhere other than the yarn.lock the scan checks.`,
      );
    }
    if (yarnrcSet(f, "networkSettings")) {
      return no(
        `${f} sets networkSettings, which the wrapper does not support: the sandbox sets its own to keep the fetch phase from downloading GitHub sources, and a setting here could override it.`,
      );
    }
  }
  let why = netCheck(root, home);
  if (why) return no(why);
  why = manifestCheck(root);
  if (why) return no(`${root}${path.sep}${why}`);
  const lock = root + path.sep + "yarn.lock";
  why = lockCheck(lock, origins(home));
  if (why.startsWith("G ")) {
    return no(
      `${lock} has a line the wrapper cannot read safely (line ${why.slice(2)}): the checks read the layout Yarn writes, and other YAML could hide a dependency from them. Run yarn install with the bypass below to let Yarn rewrite the file, or restore it from git.`,
    );
  }
  if (why.startsWith("A ")) {
    return no(
      `${lock} downloads a package from a server that is not a registry in ${rcs[1]} (${why.slice(2)}): Yarn sends the registry token with that download. If you trust the server, add it to ${rcs[1]} as an npmRegistryServer (top-level or under npmScopes); otherwise remove the entry from yarn.lock. Then run the command again.`,
    );
  }
  if (why) {
    return no(
      `${lock} resolves a dependency from a source the wrapper does not support (${why.slice(2)}): Yarn packs git and GitHub dependencies, and makes exec: ones, by running their scripts while it fetches, when the registry token is still available. Supported sources are the npm registry, workspaces, local folders and tarballs, patches of those, and tarball URLs off GitHub.`,
    );
  }
  let linker = "";
  for (const f of rcs) {
    if (!yarnrcSet(f, "nodeLinker")) continue;
    const re = new RegExp(`^["']?nodeLinker["']?${SP}*:`);
    linker = records(bytes(f))
      .filter((l) => re.test(l))
      .pop()
      .replace(new RegExp(`^[^:]*:${SP}*`), "")
      .replace(new RegExp(`${SP}+#.*`, "s"), "")
      .replace(new RegExp(`${SP}+$`), "")
      .replace(/^["']/, "")
      .replace(/["']$/, "");
    break;
  }
  if (linker === "node-modules" || linker === "pnpm") return { ok: true, spec };
  return no(
    `${root} installs with Plug'n'Play (nodeLinker: ${linker || "pnp, the default"}), which the wrapper does not support: the sandbox copies back node_modules, and Plug'n'Play has none. Set nodeLinker: node-modules in .yarnrc.yml and run the command again.`,
  );
}

const GITHUB_BLOCK = 'networkSettings:\n  "github.com":\n    enableNetwork: false\n';
const lstat = (f) => {
  try {
    return fs.lstatSync(f);
  } catch {
    return null;
  }
};
// Appends text on a line of its own.
function appendBlock(f, text) {
  let nl = "";
  try {
    const cur = fs.readFileSync(f);
    if (cur.length > 0 && cur[cur.length - 1] !== 10) nl = "\n";
  } catch {
    nl = "";
  }
  fs.appendFileSync(f, nl + text);
}

// Fills the sandbox with the files the fetch needs. A file that does not get
// there fails the run before any container starts.
function stage(root, home, tmp, snap, os, cpu) {
  for (const f of ["package.json", "yarn.lock", ".yarnrc", ".npmrc", ".yarnrc.yml"]) {
    if (!isFile(path.join(root, f))) continue;
    try {
      fs.copyFileSync(path.join(root, f), path.join(tmp, f));
    } catch {
      return { ok: false, reason: `could not copy ${f} into the sandbox; nothing was installed.` };
    }
  }
  const list = members(root);
  for (const m of list) {
    try {
      fs.mkdirSync(path.join(tmp, m), { recursive: true });
      fs.copyFileSync(path.join(root, m, "package.json"), path.join(tmp, m, "package.json"));
    } catch {
      return { ok: false, reason: `could not copy ${safe(m)}/package.json into the sandbox; nothing was installed.` };
    }
  }
  fs.writeFileSync(path.join(snap, "members.json"), JSON.stringify(list));
  // Only regular .patch files in real folders: a symlink could bring any file
  // on this machine into the sandbox, where build scripts read it.
  const yarnDir = lstat(path.join(root, ".yarn"));
  const patches = path.join(root, ".yarn", "patches");
  const patchDir = lstat(patches);
  if (yarnDir && !yarnDir.isSymbolicLink() && patchDir && patchDir.isDirectory()) {
    try {
      fs.mkdirSync(path.join(tmp, ".yarn", "patches"), { recursive: true });
      for (const name of fs.readdirSync(patches)) {
        if (name.startsWith(".") || !name.endsWith(".patch")) continue;
        const st = lstat(path.join(patches, name));
        if (st && st.isFile()) fs.copyFileSync(path.join(patches, name), path.join(tmp, ".yarn", "patches", name));
      }
    } catch {
      return { ok: false, reason: "could not copy .yarn/patches into the sandbox; nothing was installed." };
    }
  }
  // The containers' ~/.yarnrc.yml: the user's own, then the block that keeps
  // the fetch phase off github.com (the image has no git to pack a source with).
  try {
    const homeRc = path.join(tmp, ".safe-home", ".yarnrc.yml");
    fs.mkdirSync(path.dirname(homeRc), { recursive: true });
    if (isFile(path.join(home, ".yarnrc.yml"))) fs.copyFileSync(path.join(home, ".yarnrc.yml"), homeRc);
    appendBlock(homeRc, GITHUB_BLOCK);
    const rc = path.join(tmp, ".yarnrc.yml");
    if (/^(win32|darwin)$/.test(os) && /^(x64|arm64)$/.test(cpu) && !yarnrcSet(rc, "supportedArchitectures")) {
      appendBlock(rc, `supportedArchitectures:\n  os:\n    - current\n    - ${os}\n  cpu:\n    - current\n    - ${cpu}\n`);
    }
  } catch {
    return { ok: false, reason: "could not write the sandbox's .yarnrc.yml files; nothing was installed." };
  }
  return { ok: true, members: list };
}

const readMembers = (snap) => JSON.parse(fs.readFileSync(path.join(snap, "members.json"), "utf8"));

// The manifests as the fetch left them, kept where no container can write.
function snapshot(tmp, snap) {
  const tree = path.join(snap, "tree");
  fs.mkdirSync(tree, { recursive: true });
  for (const f of ["package.json", "yarn.lock"]) {
    if (isFile(path.join(tmp, f))) fs.copyFileSync(path.join(tmp, f), path.join(tree, f));
  }
  for (const m of readMembers(snap)) {
    if (!isFile(path.join(tmp, m, "package.json"))) continue;
    fs.mkdirSync(path.join(tree, m), { recursive: true });
    fs.copyFileSync(path.join(tmp, m, "package.json"), path.join(tree, m, "package.json"));
  }
  return { ok: true };
}

function stripFile(f) {
  if (!isFile(f)) return;
  const re = new RegExp(`npmauth(token|ident)["']?${SP}*:`);
  const indent = new RegExp(`^${SP}*`);
  const blank = new RegExp(`^${SP}*$`);
  const out = [];
  let skip = false;
  let ind = 0;
  const text = bytes(f);
  // awk reads these bytes differently from one flavor to the next, and the
  // checks refuse them before the fetch, so one here was written during it.
  if (/[\0\x80-\xff]/.test(text)) throw new Error("not printable ASCII");
  for (const l of records(text)) {
    if (skip) {
      if (blank.test(l) || indent.exec(l)[0].length > ind) continue;
      skip = false;
    }
    if (re.test(lower(l))) {
      ind = indent.exec(l)[0].length;
      skip = true;
      continue;
    }
    out.push(`${l.replace(/:\/\/[^/"' ]*@/g, "://")}\n`);
  }
  fs.writeFileSync(`${f}.clean`, out.join(""), "latin1");
  fs.renameSync(`${f}.clean`, f);
}

function strip(tmp) {
  for (const f of [path.join(tmp, ".yarnrc.yml"), path.join(tmp, ".safe-home", ".yarnrc.yml")]) {
    try {
      stripFile(f);
    } catch {
      fs.rmSync(`${f}.clean`, { force: true });
      return {
        ok: false,
        reason: `could not remove the registry credentials from ${f}; the build phase did not run.`,
      };
    }
  }
  return { ok: true };
}

function restore(snap, root) {
  const tree = path.join(snap, "tree");
  const rels = ["package.json", "yarn.lock", ...readMembers(snap).map((m) => `${m}/package.json`)];
  for (const rel of rels) {
    if (!isFile(path.join(tree, rel))) continue;
    try {
      fs.copyFileSync(path.join(tree, rel), path.join(root, rel));
    } catch {
      return { ok: false, reason: `could not copy ${safe(rel)} back to the project.` };
    }
  }
  return { ok: true };
}

const MODES = { check: [check, 3], stage: [stage, 6], snapshot: [snapshot, 2], strip: [strip, 1], restore: [restore, 2] };

function main(argv) {
  const [mode, ...args] = argv;
  const entry = Object.prototype.hasOwnProperty.call(MODES, mode) ? MODES[mode] : null;
  if (!entry || args.length !== entry[1] || args.some((a) => a === "")) {
    process.stderr.write("usage: yarn-berry-check.js check|stage|snapshot|strip|restore <args>\n");
    process.exit(2);
  }
  let r;
  try {
    r = entry[0](...args);
  } catch (e) {
    // Any failure is a refusal: the caller runs nothing on an answer that is not "ok".
    r = { ok: false, reason: `the Yarn 2+ helper failed (${mode}): ${e && e.message ? e.message : e}` };
  }
  const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
  const out = [r.ok ? "ok" : "refuse"];
  if (r.reason !== undefined) out.push(`reason ${b64(r.reason)}`);
  if (r.spec !== undefined) out.push(`spec ${b64(r.spec)}`);
  for (const m of r.members ?? []) out.push(`member ${b64(m)}`);
  out.push("end");
  process.stdout.write(`${out.join("\n")}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { check, stage, snapshot, strip, restore, members, lockCheck, origins, netCheck, yarnrcPlain, yarnrcInterp, yarnrcSet, pin };
