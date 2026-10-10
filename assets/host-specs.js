// Lists name@version for the lockfile's optional packages that are built for
// the given platform (e.g. @esbuild/darwin-arm64). Usage: node host-specs.js OS CPU
// Run in the install container, where npm picked only the Linux builds. The
// lockfile already lists every platform's build, so what this prints went
// through the same malware scan as the rest of the tree.
const fs = require("node:fs");

const [os, cpu] = process.argv.slice(2);
if (!os || !cpu) {
  console.error("usage: node host-specs.js OS CPU");
  process.exit(2);
}

// npm's os/cpu lists allow "!name" to exclude a platform.
const allows = (list, value) =>
  !list || (list.includes(value) && !list.includes(`!${value}`));

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const MARK = "node_modules/";
const specs = [];
for (const [key, pkg] of Object.entries(lock.packages || {})) {
  if (!key || !pkg.optional || !(pkg.os || pkg.cpu)) continue;
  if (!allows(pkg.os, os) || !allows(pkg.cpu, cpu)) continue;
  specs.push(`${key.slice(key.lastIndexOf(MARK) + MARK.length)}@${pkg.version}`);
}
console.log(specs.join("\n"));
