const { spawn } = require("node:child_process");
const {
  SHIM_DIR,
  missingShims,
  readEnabledManagers,
  shimPath,
  spawnCommand,
} = require("../util/shims");
const { red, bold } = require("../util/colors");

// safe-pnpm exec [--] CMD [ARGS...] — runs CMD with the shims first on PATH,
// so CMD and everything it starts reach the wrappers when they run a package
// manager by name. Exits with CMD's exit code.
function exec(args) {
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (argv.length === 0) {
    console.error("Usage: safe-pnpm exec -- CMD [ARGS...]");
    process.exit(2);
  }
  const missing = missingShims(readEnabledManagers());
  if (missing.length > 0) {
    console.error(
      red(
        `safe-pnpm: shims missing from ${SHIM_DIR} (${missing.join(", ")}); not running ${argv[0]}. Run ${bold("safe-pnpm update")}.`,
      ),
    );
    process.exit(1);
  }

  // Windows keeps PATH in the environment as Path; spawn passes both spellings
  // on, so set the one that is there.
  const key =
    process.platform === "win32"
      ? Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ||
        "Path"
      : "PATH";
  const env = { ...process.env, [key]: shimPath(process.env[key]) };
  const {
    file,
    args: fileArgs,
    options,
  } = spawnCommand(argv, { ...env, PATH: env[key] });
  const child = spawn(file, fileArgs, { stdio: "inherit", env, ...options });
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
