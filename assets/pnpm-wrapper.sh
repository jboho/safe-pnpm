# pnpm Docker isolation wrapper — bash/zsh compatible
# Source this file from your shell config:
#   source ~/.safe-pnpm/pnpm-wrapper.sh
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# All other commands pass through to native pnpm unchanged.
# Escape hatch: `command pnpm install` bypasses to native pnpm (a backslash only
# bypasses aliases, not shell functions like this wrapper).
# With the PATH shims (~/.safe-pnpm/bin) on PATH, `command pnpm` reaches the shim,
# so run the real binary by its absolute path instead.

[ -z "${_SAFE_PKG_SHARED_LOADED:-}" ] && \
  # shellcheck disable=SC1091
  source "$HOME/.safe-pnpm/_safe_pkg_shared.sh" 2>/dev/null

pnpm() {
  _safe_pkg_runner_check pnpm "$@" || return 1
  _safe_pkg_is_install pnpm "$@" || { _safe_pkg_native pnpm "$@"; return; }

  _safe_pkg_dispatch "pnpm" "pnpm-lock.yaml" "pnpm-workspace.yaml" \
    "package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc" "$@"
}

# pnpx is pnpm dlx: same OSV check, then native.
pnpx() {
  _safe_pkg_runner_check pnpx "$@" || return 1
  _safe_pkg_native pnpx "$@"
}

# On a disk that ignores case (macOS by default) the shell finds the real
# program under any spelling of its name, so every other spelling runs the
# wrapper too. The function keyword keeps zsh from alias-expanding the names.
for _safe_pkg_n in PNPM PNPm PNpM PNpm PnPM PnPm PnpM Pnpm pNPM pNPm pNpM pNpm pnPM pnPm pnpM; do
  eval "function $_safe_pkg_n { pnpm \"\$@\"; }"
done
for _safe_pkg_n in PNPX PNPx PNpX PNpx PnPX PnPx PnpX Pnpx pNPX pNPx pNpX pNpx pnPX pnPx pnpX; do
  eval "function $_safe_pkg_n { pnpx \"\$@\"; }"
done
unset _safe_pkg_n
