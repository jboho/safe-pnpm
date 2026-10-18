#!/usr/bin/env bash
# safe-pnpm PATH shim. Installed as pnpm, pnpx, npm, npx and yarn in
# ~/.safe-pnpm/bin so programs that start a package manager themselves
# (editors, MCP servers, child_process.spawn) get the same checks as the shell
# functions: it sources the same wrapper and calls the same function.
# _safe_pkg_native skips this directory when it runs the real binary.

_SAFE_PKG_SHIM_DIR="$(cd -P "$(dirname "$0")" 2>/dev/null && pwd)"
# On a disk that ignores case, PNPM finds this file too.
name="$(basename "$0" | tr '[:upper:]' '[:lower:]')"
case "$name" in
  pnpm|pnpx) wrapper=pnpm ;;
  npm|npx) wrapper=npm ;;
  yarn) wrapper=yarn ;;
  *)
    echo "✗ safe-pnpm: unknown shim name $name; expected pnpm, pnpx, npm, npx or yarn." >&2
    exit 2 ;;
esac

for f in _safe_pkg_shared.sh "$wrapper-wrapper.sh"; do
  # shellcheck disable=SC1090
  if [ ! -f "$HOME/.safe-pnpm/$f" ] || ! source "$HOME/.safe-pnpm/$f"; then
    echo "✗ safe-pnpm: cannot load $HOME/.safe-pnpm/$f, so $name was not run. Run \`safe-pnpm update\`, or take $_SAFE_PKG_SHIM_DIR off PATH." >&2
    exit 1
  fi
done

"$name" "$@"
