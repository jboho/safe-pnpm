# pnpm Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/pnpm-wrapper.sh
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native pnpm unchanged.
# Escape hatch: `command pnpm install` bypasses to native pnpm (a backslash only
# bypasses aliases, not shell functions like this wrapper).

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

pnpm() {
  _safe_pkg_is_install pnpm "$@" || { command pnpm "$@"; return; }

  _safe_pkg_dispatch "pnpm" "pnpm-lock.yaml" "pnpm-workspace.yaml" \
    "package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc" "$@"
}
