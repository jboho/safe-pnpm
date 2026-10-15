// Adds the host's platform to pnpm's supportedArchitectures in a sandbox copy
// of a project, and takes it out again before the manifest is copied back.
//
//   node pnpm-arch.js apply DIR OS CPU SAVED
//   node pnpm-arch.js restore FILE SAVED
//
// Runs on the host with the host's node. See _safe_pkg_host_platform in
// _safe_pkg_shared.sh for why the setting is needed.
//
// pnpm versions read the setting from different places (probed 2026-10-15 on
// 8.15.9, 9.15.0, 10.18.3 and 11.5.3):
//   pnpm 8, 9  — package.json "pnpm" field only. They ignore it in
//                pnpm-workspace.yaml, and a pnpm-workspace.yaml without a
//                `packages` list fails every command ("packages field missing
//                or empty"). Flags, --config. and .npmrc do not set it.
//   pnpm 10    — package.json and pnpm-workspace.yaml (with or without packages).
//   pnpm 11    — pnpm-workspace.yaml only; it warns about and ignores the
//                package.json field.
// The image runs pnpm 11, which hands off to the version in packageManager, so
// the pin decides where the setting goes. Guessing an old pin as new would
// break the install; guessing a new one as old only misses the host build, so
// a pin whose version can't be read is treated as old.
//
// apply: changes nothing when the project already sets supportedArchitectures
// where its pnpm reads it. Writing package.json first saves its exact bytes to
// SAVED (a host-only path); nothing is saved when only pnpm-workspace.yaml
// changes, since that file is never copied back.
//
// restore: FILE is the post-fetch snapshot of package.json, which may also hold
// pnpm's own edits (add, remove, update). Removes the injected setting, writes
// SAVED back byte for byte when nothing else changed, and deletes SAVED.
//
// Prints nothing on stdout. Exit 0 on success, 1 on failure (reason on stderr),
// 2 on bad usage.
const fs = require("node:fs");
const path = require("node:path");

const BOM = "﻿";

function parseJson(text) {
  return JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
}

// Re-serializes in the style of `like`: its indent, line endings, BOM and
// final newline. A one-line file stays on one line.
function serialize(obj, like) {
  const indent = like.match(/\n([ \t]+)\S/);
  let out = JSON.stringify(obj, null, indent ? indent[1] : 0);
  if (/\r?\n$/.test(like)) out += "\n";
  if (like.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  return like.startsWith(BOM) ? BOM + out : out;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Major version of the pnpm a project pins, null when it pins none. pnpm reads
// packageManager first; devEngines.packageManager can be one entry or a list.
function pinnedMajor(pkg) {
  if (!isObject(pkg)) return null;
  const pm = pkg.packageManager;
  if (typeof pm === "string" && pm.startsWith("pnpm@")) {
    const m = /^pnpm@v?(\d+)/.exec(pm);
    return m ? Number(m[1]) : 0;
  }
  const de = isObject(pkg.devEngines) ? pkg.devEngines.packageManager : null;
  for (const e of [].concat(de || [])) {
    if (!isObject(e) || e.name !== "pnpm") continue;
    if (e.version === undefined) return null;
    const m = /(\d+)/.exec(String(e.version));
    return m ? Number(m[1]) : 0;
  }
  return null;
}

function apply(dir, os, cpu, saved) {
  const pkgPath = path.join(dir, "package.json");
  const wsPath = path.join(dir, "pnpm-workspace.yaml");
  const pkgText = fs.existsSync(pkgPath)
    ? fs.readFileSync(pkgPath, "utf8")
    : null;
  let pkg = null;
  try {
    pkg = pkgText === null ? null : parseJson(pkgText);
  } catch {
    // pnpm reports a broken package.json itself; leave it alone.
    return;
  }
  const wsText = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, "utf8") : "";

  const major = pinnedMajor(pkg);
  const readsYaml = major === null || major >= 10;
  const readsManifest = major !== null && major <= 10;
  const manifestHas =
    isObject(pkg) &&
    isObject(pkg.pnpm) &&
    pkg.pnpm.supportedArchitectures !== undefined;
  // Top level only; an indented or commented-out key doesn't count.
  const yamlHas = /^supportedArchitectures:/m.test(wsText);
  if ((readsYaml && yamlHas) || (readsManifest && manifestHas)) return;

  if (readsYaml) {
    // A file with no trailing newline would glue the key onto its last line.
    const sep = wsText && !wsText.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(
      wsPath,
      `${wsText}${sep}supportedArchitectures:\n  os: [current, ${os}]\n  cpu: [current, ${cpu}]\n`,
    );
    return;
  }

  // A "pnpm" key that isn't an object is the project's to sort out.
  if (!isObject(pkg) || (pkg.pnpm !== undefined && !isObject(pkg.pnpm))) return;
  fs.copyFileSync(pkgPath, saved);
  pkg.pnpm = {
    ...pkg.pnpm,
    supportedArchitectures: { os: ["current", os], cpu: ["current", cpu] },
  };
  fs.writeFileSync(pkgPath, serialize(pkg, pkgText));
}

function restore(file, saved) {
  if (!fs.existsSync(saved)) return;
  if (fs.existsSync(file)) {
    const snapText = fs.readFileSync(file, "utf8");
    const snap = parseJson(snapText);
    const origBytes = fs.readFileSync(saved);
    const orig = parseJson(origBytes.toString("utf8"));
    if (isObject(snap) && isObject(snap.pnpm) && "supportedArchitectures" in snap.pnpm) {
      delete snap.pnpm.supportedArchitectures;
      if (Object.keys(snap.pnpm).length === 0 && !(isObject(orig) && "pnpm" in orig)) {
        delete snap.pnpm;
      }
      if (JSON.stringify(snap) === JSON.stringify(orig)) {
        fs.writeFileSync(file, origBytes);
      } else {
        fs.writeFileSync(file, serialize(snap, snapText));
      }
    }
  }
  fs.unlinkSync(saved);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "apply" && args.length === 4 && args.every(Boolean)) {
    apply(...args);
  } else if (cmd === "restore" && args.length === 2 && args.every(Boolean)) {
    restore(...args);
  } else {
    console.error(
      "usage: node pnpm-arch.js apply DIR OS CPU SAVED | restore FILE SAVED",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`pnpm-arch: ${e.message}`);
  process.exit(1);
}
