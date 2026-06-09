#!/usr/bin/env node

const [, , cmd] = process.argv;

const commands = {
  setup: () => require("../lib/commands/setup")(),
  update: () => require("../lib/commands/update")(),
  doctor: () => require("../lib/commands/doctor")(),
};

if (!commands[cmd]) {
  console.log("Usage: safe-pnpm <setup|update|doctor>");
  console.log("");
  console.log("  setup    Install safe-pnpm on this machine");
  console.log("  update   Refresh wrapper files and rebuild the Docker image");
  console.log("  doctor   Check installation health");
  process.exit(cmd ? 1 : 0);
}

Promise.resolve(commands[cmd]()).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
