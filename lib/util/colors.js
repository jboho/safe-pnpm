const tty = process.stdout.isTTY;

const c = (code) => (tty ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);

module.exports = {
  green: c("32"),
  red: c("31"),
  yellow: c("33"),
  cyan: c("36"),
  bold: c("1"),
  dim: c("2"),
};
