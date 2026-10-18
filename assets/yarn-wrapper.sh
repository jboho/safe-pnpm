# yarn Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/yarn-wrapper.sh
#
# Intercepts install-class yarn commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native yarn unchanged.
# Escape hatch: `command yarn install` bypasses to native yarn (a backslash only
# bypasses aliases, not shell functions like this wrapper).
# With the PATH shims (~/.safe-pnpm/bin) on PATH, `command yarn` reaches the shim,
# so run the real binary by its absolute path instead.
# Note: yarn v1 only. berry (v2+) requires separate handling.

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

yarn() {
  _safe_pkg_runner_check yarn "$@" || return 1
  _safe_pkg_is_install yarn "$@" || { _safe_pkg_native yarn "$@"; return; }

  _safe_pkg_dispatch "yarn" "yarn.lock" "" \
    "package.json yarn.lock .yarnrc .npmrc" "$@"
}

# On a disk that ignores case (macOS by default) the shell finds the real
# program under any spelling of its name, so every other spelling runs the
# wrapper too. The function keyword keeps zsh from alias-expanding the names.
for _safe_pkg_n in YARN YARn YArN YArn YaRN YaRn YarN Yarn yARN yARn yArN yArn yaRN yaRn yarN; do
  eval "function $_safe_pkg_n { yarn \"\$@\"; }"
done
unset _safe_pkg_n
