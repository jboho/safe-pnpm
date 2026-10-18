# npm Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/npm-wrapper.sh
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native npm unchanged.
# Escape hatch: `command npm install` bypasses to native npm (a backslash only
# bypasses aliases, not shell functions like this wrapper).
# With the PATH shims (~/.safe-pnpm/bin) on PATH, `command npm` reaches the shim,
# so run the real binary by its absolute path instead.

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

npm() {
  _safe_pkg_runner_check npm "$@" || return 1
  _safe_pkg_is_install npm "$@" || { _safe_pkg_native npm "$@"; return; }

  _safe_pkg_dispatch "npm" "package-lock.json" "" \
    "package.json package-lock.json .npmrc" "$@"
}

# npx fetches a package and runs it. Same OSV check as `npm exec`, then native.
npx() {
  _safe_pkg_runner_check npx "$@" || return 1
  _safe_pkg_native npx "$@"
}

# On a disk that ignores case (macOS by default) the shell finds the real
# program under any spelling of its name, so every other spelling runs the
# wrapper too. The function keyword keeps zsh from alias-expanding the names.
for _safe_pkg_n in NPM NPm NpM Npm nPM nPm npM; do
  eval "function $_safe_pkg_n { npm \"\$@\"; }"
done
for _safe_pkg_n in NPX NPx NpX Npx nPX nPx npX; do
  eval "function $_safe_pkg_n { npx \"\$@\"; }"
done
unset _safe_pkg_n
