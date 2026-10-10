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

// The specs are expanded unquoted into an `npm install` in a container that has
// the registry token and network. A name or version with a space or a leading
// "-" would become an extra npm flag (--ignore-scripts=false, --registry=...),
// so anything outside npm's name and semver grammar fails the whole step.
const NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
if (!lock.packages) {
  console.error("host-specs: lockfile has no packages map (lockfileVersion 1); skipping");
  process.exit(0);
}
const MARK = "node_modules/";
const specs = [];
for (const [key, pkg] of Object.entries(lock.packages)) {
  // Workspace members and links have no node_modules/ segment or no version.
  if (!key.includes(MARK) || pkg.link || !pkg.version) continue;
  if (!pkg.optional || !(pkg.os || pkg.cpu)) continue;
  if (!allows(pkg.os, os) || !allows(pkg.cpu, cpu)) continue;
  // An alias entry's key is the alias; "name" is the real package.
  const name = pkg.name || key.slice(key.lastIndexOf(MARK) + MARK.length);
  if (!NAME.test(name) || !VERSION.test(pkg.version)) {
    console.error(`host-specs: refusing odd package name or version in ${key}`);
    process.exit(1);
  }
  specs.push(`${name}@${pkg.version}`);
}
console.log(specs.join("\n"));
