# npm Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/npm-wrapper.sh
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native npm unchanged.
# Escape hatch: `command npm install` bypasses to native npm (a backslash only
# bypasses aliases, not shell functions like this wrapper).

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

npm() {
  _safe_pkg_runner_check npm "$@" || return 1
  _safe_pkg_is_install npm "$@" || { command npm "$@"; return; }

  _safe_pkg_dispatch "npm" "package-lock.json" "" \
    "package.json package-lock.json .npmrc" "$@"
}

# npx fetches a package and runs it. Same OSV check as `npm exec`, then native.
npx() {
  _safe_pkg_runner_check npx "$@" || return 1
  command npx "$@"
}
