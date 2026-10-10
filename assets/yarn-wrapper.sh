# yarn Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/yarn-wrapper.sh
#
# Intercepts install-class yarn commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native yarn unchanged.
# Escape hatch: `command yarn install` bypasses to native yarn (a backslash only
# bypasses aliases, not shell functions like this wrapper).
# Note: yarn v1 only. berry (v2+) requires separate handling.

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

yarn() {
  _safe_pkg_runner_check yarn "$@" || return 1
  _safe_pkg_is_install yarn "$@" || { command yarn "$@"; return; }

  _safe_pkg_dispatch "yarn" "yarn.lock" "" \
    "package.json yarn.lock .yarnrc .npmrc" "$@"
}
