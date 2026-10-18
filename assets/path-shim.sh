#!/usr/bin/env bash
# safe-pnpm PATH shim. Installed as pnpm, pnpx, npm, npx and yarn in
# ~/.safe-pnpm/bin so programs that start a package manager themselves
# (editors, MCP servers, child_process.spawn) get the same checks as the shell
# functions: it sources the same wrapper and calls the same function.
# _safe_pkg_native skips this directory when it runs the real binary.

# Each level of nesting (a package script that runs pnpm again) passes through
# here once. A chain this deep is a loop, for example a wrapper that runs
# `command pnpm` and finds this shim again; stop it instead of forking forever.
_SAFE_PKG_SHIM_DEPTH=$(( ${_SAFE_PKG_SHIM_DEPTH:-0} + 1 ))
export _SAFE_PKG_SHIM_DEPTH
if [ "$_SAFE_PKG_SHIM_DEPTH" -gt 32 ]; then
  echo "✗ safe-pnpm: the PATH shim was entered $_SAFE_PKG_SHIM_DEPTH times in a row, so it stopped. Run \`safe-pnpm update\`, or take $(dirname "$0") off PATH." >&2
  exit 1
fi

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

# Wrappers older than the shims pass commands on with `command pnpm`, which
# finds this shim again. Only run with wrappers that skip the shim directory.
if ! type _safe_pkg_native >/dev/null 2>&1; then
  echo "✗ safe-pnpm: the wrappers in $HOME/.safe-pnpm are older than the PATH shims, so $name was not run. Run \`safe-pnpm update\`, or take $_SAFE_PKG_SHIM_DIR off PATH." >&2
  exit 1
fi

"$name" "$@"
