#!/usr/bin/env node

const [, , cmd, ...args] = process.argv;

const commands = {
  setup: () => require("../lib/commands/setup")(args),
  update: () => require("../lib/commands/update")(),
  doctor: () => require("../lib/commands/doctor")(),
  exec: () => require("../lib/commands/exec")(args),
};

if (!commands[cmd]) {
  console.log("Usage: safe-pnpm <setup|update|doctor|exec>");
  console.log("");
  console.log("  setup    Install safe-pnpm on this machine");
  console.log(
    "           --path-shims         also put the shims first on PATH in your shell rc",
  );
  console.log("           --remove-path-shims  take that PATH line back out");
  console.log("  update   Refresh wrapper files and rebuild the Docker image");
  console.log("  doctor   Check installation health");
  console.log(
    "  exec     exec -- CMD [ARGS...]: run CMD with the shims first on PATH",
  );
  process.exit(cmd ? 1 : 0);
}

Promise.resolve(commands[cmd]()).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
