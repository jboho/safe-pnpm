#!/usr/bin/env node

/**
 * Symlink containment check for copy-back.
 *
 * Copy-back keeps symlinks as links (pnpm's node_modules is built from them),
 * but phase 2 runs untrusted build scripts that can plant links of their own.
 * A link copied to the host resolves against the host project, so one aimed at
 * an absolute path or climbing out of the project would hand the next host
 * command (node, a bundler, an editor) files from anywhere on the machine.
 *
 * Every link under <base>/<rel> must have a target of the form
 * `../` * n followed by plain names, where n does not climb above <base>.
 * That is the only shape pnpm, npm and yarn write (`.pnpm/x/node_modules/x`,
 * `../../y@1/node_modules/y`, `../packages/a`). A `..` after a plain name is
 * refused too: the kernel resolves it against the target of the link before
 * it, so it can climb further than the text suggests.
 *
 * The walk never follows links, so a hostile tree cannot steer it.
 *
 * Usage:
 *   node link-check.js <base> <rel>
 *
 * Exit codes:
 *   0 — PASS:     every link stays inside <base>
 *   3 — FINDINGS: at least one link escapes; the offenders go to stderr
 *   4 — FAILED:   the tree could not be read
 */

const fs = require("fs");
const path = require("path");

const EXIT_PASS = 0;
const EXIT_FINDINGS = 3;
const EXIT_FAILED = 4;
const MAX_REPORTED = 10;

// depth: how many directories the link's own folder sits below <base>.
function escapes(target, depth) {
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    return true;
  }
  let up = 0;
  let descended = false;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (descended) return true;
      up++;
    } else {
      descended = true;
    }
  }
  return up > depth;
}

function findEscapingLinks(base, rel) {
  const found = [];
  const stack = [rel];
  while (stack.length > 0) {
    const dirRel = stack.pop();
    const depth = dirRel.split("/").filter(Boolean).length;
    for (const entry of fs.readdirSync(path.join(base, dirRel), {
      withFileTypes: true,
    })) {
      const entryRel = `${dirRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(path.join(base, entryRel));
        if (escapes(target, depth)) found.push(`${entryRel} -> ${target}`);
      } else if (entry.isDirectory()) {
        stack.push(entryRel);
      }
    }
  }
  return found.sort();
}

function main(argv) {
  const [base, rel] = argv;
  if (!base || !rel) {
    process.stderr.write("usage: link-check.js <base> <rel>\n");
    return EXIT_FAILED;
  }
  let found;
  try {
    found = findEscapingLinks(base, rel.replace(/\/+$/, ""));
  } catch (err) {
    process.stderr.write(`link check could not read ${rel}: ${err.message}\n`);
    return EXIT_FAILED;
  }
  if (found.length === 0) return EXIT_PASS;
  const shown = found.slice(0, MAX_REPORTED).map((f) => `  ${f}\n`);
  if (found.length > MAX_REPORTED) {
    shown.push(`  ...and ${found.length - MAX_REPORTED} more\n`);
  }
  process.stderr.write(
    `${found.length} link(s) in ${rel} point outside the project:\n${shown.join("")}`,
  );
  return EXIT_FINDINGS;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  EXIT_PASS,
  EXIT_FINDINGS,
  EXIT_FAILED,
  escapes,
  findEscapingLinks,
};
