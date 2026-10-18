const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { INSTALL_DIR } = require("../util/docker");
const { SHIM_DIR, missingShims } = require("../util/shims");
const { red, bold } = require("../util/colors");

function enabledManagers() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(INSTALL_DIR, "config.json"), "utf8"),
    );
    return config.enabledManagers || ["pnpm"];
  } catch {
    return ["pnpm"];
  }
}

// safe-pnpm exec [--] CMD [ARGS...] — runs CMD with the shims first on PATH,
// so CMD and everything it starts reach the wrappers when they run a package
// manager by name. Exits with CMD's exit code.
function exec(args) {
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (argv.length === 0) {
    console.error("Usage: safe-pnpm exec -- CMD [ARGS...]");
    process.exit(2);
  }
  const missing = missingShims(enabledManagers());
  if (missing.length > 0) {
    console.error(
      red(
        `safe-pnpm: shims missing from ${SHIM_DIR} (${missing.join(", ")}); not running ${argv[0]}. Run ${bold("safe-pnpm update")}.`,
      ),
    );
    process.exit(1);
  }

  const env = {
    ...process.env,
    PATH: [SHIM_DIR, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, forward);
  }
  return new Promise(() => {
    child.on("error", (err) => {
      console.error(red(`safe-pnpm: cannot run ${argv[0]}: ${err.message}`));
      process.exit(127);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
          process.removeListener(s, forward);
        }
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code);
    });
  });
}

module.exports = exec;
