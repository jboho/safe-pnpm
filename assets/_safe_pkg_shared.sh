# _safe_pkg_shared.sh — shared logic for safe-pnpm, safe-npm, safe-yarn wrappers
# Sourced automatically by each manager wrapper — do not source directly.

_SAFE_PKG_SHARED_LOADED=1

_safe_pkg_prescan() {
  local manager="$1"
  local lockfile="$2"
  # socket_flag is set to 1 by the wrapper when `--socket` was passed on the
  # command line. Combined with SAFE_PNPM_ENABLE_SOCKET, it opts this run into
  # the Socket behavioral scan (off by default).
  local socket_flag="${3:-0}"
  local interactive=0
  [ -t 0 ] && interactive=1

  if [ -f "$lockfile" ]; then
    echo "→ $manager audit..." >&2
    case "$manager" in
      pnpm) command pnpm audit --audit-level moderate 2>/dev/null ;;
      npm)  command npm  audit --audit-level moderate 2>/dev/null ;;
      yarn) command yarn audit 2>/dev/null ;;
    esac || {
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  %s audit found issues. Continue anyway? [y/N] " "$manager" >&2
        read -r _ans
        case "$_ans" in [Yy]*) ;; *) return 1 ;; esac
      else
        echo "⚠️  $manager audit found issues — continuing in non-interactive mode." >&2
      fi
    }
  fi

  local sha="$HOME/.safe-pnpm/scan-shai-hulud.js"
  if [ -f "$sha" ]; then
    echo "→ Supply chain scan (Shai Hulud 2)..." >&2
    node "$sha" "$(pwd)" 2>/dev/null || {
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  Supply chain scan flagged issues. Continue anyway? [y/N] " >&2
        read -r _ans
        case "$_ans" in [Yy]*) ;; *) return 1 ;; esac
      else
        echo "⚠️  Supply chain scan flagged issues — continuing in non-interactive mode." >&2
      fi
    }
  fi

  # Socket is opt-in: it needs an authenticated account and makes a network
  # call, so it only runs when the user enables it globally
  # (SAFE_PNPM_ENABLE_SOCKET=1) or per-invocation (`--socket`).
  local socket_enabled=0
  if [ "${SAFE_PNPM_ENABLE_SOCKET:-}" = "1" ] || [ "$socket_flag" = "1" ]; then
    socket_enabled=1
  fi
  local socket_cmd="$HOME/.safe-pnpm/socket"
  if [ "$socket_enabled" -eq 1 ] && [ -f "$socket_cmd" ]; then
    echo "→ Socket behavioral scan..." >&2
    "$socket_cmd" scan create . --no-spinner --no-banner 2>/dev/null || {
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  Socket flagged issues. Continue anyway? [y/N] " >&2
        read -r _ans
        case "$_ans" in [Yy]*) ;; *) return 1 ;; esac
      else
        echo "⚠️  Socket flagged issues — continuing in non-interactive mode." >&2
      fi
    }
  fi
}

# _safe_pkg_dispatch manager lockfile workspace_file manifest_files [pkg-manager-args...]
#   Shared entry point for the install-class path of every manager wrapper.
#   Strips the safe-pnpm-only `--socket` flag from the pass-through args (so it
#   never reaches the package manager), runs the prescan, then the sandboxed
#   install with the remaining args.
_safe_pkg_dispatch() {
  local manager="$1"
  local lockfile="$2"
  local workspace_file="$3"
  local manifest_files="$4"
  shift 4

  # Rotate positional params: pop each of the original args from the front and
  # either consume `--socket` or push it to the back. After $count iterations,
  # "$@" holds every arg except `--socket`, in order. This is space-safe in
  # sh/bash/zsh without relying on word-splitting.
  local socket_flag=0 count=$# arg
  while [ "$count" -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "--socket" ]; then
      socket_flag=1
    else
      set -- "$@" "$arg"
    fi
    count=$((count - 1))
  done

  _safe_pkg_prescan "$manager" "$lockfile" "$socket_flag" || return 1
  _safe_pkg_run "$manager" "$lockfile" "$workspace_file" "$manifest_files" "$@"
}

# _safe_pkg_run manager lockfile workspace_file manifest_files [pkg-manager-args...]
#   manager        — binary name (pnpm, npm, yarn)
#   lockfile       — lock file name (e.g. pnpm-lock.yaml)
#   workspace_file — sidecar workspace file to walk up for, or "" for none
#   manifest_files — space-separated list of files to copy into the sandbox
#   remaining args — passed through to the package manager inside Docker
_safe_pkg_run() {
  # zsh does not word-split unquoted parameters by default; the manifest list
  # ($manifest_files) and the docker env flags ($extra_env) below both rely on
  # sh-style splitting. localoptions reverts this when the function returns.
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split

  local manager="$1"
  local lockfile="$2"
  local workspace_file="$3"
  local manifest_files="$4"
  shift 4

  if ! docker info > /dev/null 2>&1; then
    if [ ! -t 0 ]; then
      # Non-interactive (CI, scripts): fail closed. Silently running native
      # here would execute untrusted lifecycle scripts on the host, defeating
      # the isolation guarantee. Require explicit opt-in to fall back.
      if [ "${SAFE_PNPM_ALLOW_NATIVE_FALLBACK:-}" = "1" ]; then
        echo "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native $manager." >&2
        command "$manager" "$@"; return
      fi
      echo "✗ safe-pnpm: Docker not running and no TTY — refusing native $manager (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." >&2
      return 1
    fi
    printf "⚠️  safe-pnpm: Docker not running. Use native %s? [y/N] " "$manager" >&2
    read -r _ans
    case "$_ans" in
      [Yy]*) command "$manager" "$@" ;;
      *)     return 1 ;;
    esac
    return
  fi

  local workspace_root _cwd rel_path d
  _cwd="$(pwd)"
  workspace_root="$_cwd"
  rel_path=""

  if [ -n "$workspace_file" ]; then
    d="$_cwd"
    while [ "$d" != "$HOME" ] && [ "$d" != "/" ]; do
      if [ -f "$d/$workspace_file" ]; then
        workspace_root="$d"
        rel_path="${_cwd#${workspace_root}}"
        rel_path="${rel_path#/}"
        break
      fi
      d="$(dirname "$d")"
    done
  fi

  local tmpdir
  tmpdir=$(mktemp -d)

  (
    cd "$workspace_root" || exit 1
    for f in $manifest_files; do
      [ -f "$f" ] && cp "$f" "$tmpdir/"
    done
    if [ -n "$workspace_file" ] && [ -f "$workspace_file" ]; then
      find . -name package.json -not -path "*/node_modules/*" -mindepth 2 | while read -r pkg; do
        local_dir="$tmpdir/$(dirname "$pkg")"
        mkdir -p "$local_dir"
        cp "$pkg" "$local_dir/"
      done
    fi
  )

  local workdir="/app${rel_path:+/$rel_path}"
  # Registry tokens are forwarded into the sandbox only on explicit opt-in.
  # Untrusted install lifecycle scripts run inside the container and could
  # otherwise read and exfiltrate them. Use read-only, registry-scoped tokens.
  local extra_env=""
  if [ "${SAFE_PNPM_FORWARD_TOKENS:-}" = "1" ]; then
    [ -n "${NODE_AUTH_TOKEN:-}" ] && extra_env="$extra_env -e NODE_AUTH_TOKEN"
    [ -n "${NPM_TOKEN:-}" ]       && extra_env="$extra_env -e NPM_TOKEN"
  fi

  # shellcheck disable=SC2086
  docker run --rm --cap-drop ALL \
    -v "${tmpdir}:/app" \
    -w "$workdir" \
    $extra_env \
    safe-pnpm:latest "$manager" "$@"
  local rc=$?

  if [ "$rc" -eq 0 ]; then
    if [ -d "$tmpdir/node_modules" ]; then
      rm -rf "${workspace_root}/node_modules"
      cp -r "$tmpdir/node_modules" "${workspace_root}/node_modules"
    fi
    [ -f "$tmpdir/$lockfile" ] && cp "$tmpdir/$lockfile" "${workspace_root}/$lockfile"
    if [ -n "$workspace_file" ] && [ -f "${workspace_root}/$workspace_file" ]; then
      find "$tmpdir" -mindepth 2 -name node_modules -type d | while read -r nm; do
        rel="${nm#${tmpdir}/}"
        rm -rf "${workspace_root}/${rel}"
        mkdir -p "$(dirname "${workspace_root}/${rel}")"
        cp -r "$nm" "${workspace_root}/${rel}"
      done
    fi
  fi

  rm -rf "$tmpdir"
  return $rc
}
