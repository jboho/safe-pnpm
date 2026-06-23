# npm Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/npm-wrapper.sh
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native npm unchanged.
# Escape hatch: \npm install bypasses to native npm.

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

npm() {
  case "${1:-}" in
    install|i|ci|update|uninstall|un) ;;
    *) command npm "$@"; return ;;
  esac

  _safe_pkg_prescan "npm" "package-lock.json" || return 1
  _safe_pkg_run "npm" "package-lock.json" "" \
    "package.json package-lock.json .npmrc" "$@"
}
