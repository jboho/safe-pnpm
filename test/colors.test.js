const { test } = require("node:test");
const assert = require("node:assert/strict");

// Force TTY off so ANSI codes are stripped — tests stay readable
Object.defineProperty(process.stdout, "isTTY", { value: false });

const { green, red, yellow, cyan, bold, dim } = require("../lib/util/colors");

test("colors pass strings through when not a TTY", () => {
  assert.equal(green("ok"), "ok");
  assert.equal(red("fail"), "fail");
  assert.equal(yellow("warn"), "warn");
  assert.equal(cyan("info"), "info");
  assert.equal(bold("title"), "title");
  assert.equal(dim("muted"), "muted");
});
