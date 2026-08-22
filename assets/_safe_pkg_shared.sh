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
  if [ "$socket_enabled" -eq 1 ]; then
    _safe_pkg_socket_scan "$interactive" || return 1
  fi
}

# _safe_pkg_socket_scan interactive
#   Runs the Socket behavioral scan and applies safe-pnpm's failure semantics.
#
#   Three outcomes are distinguished, because "Socket says these packages are
#   bad" and "Socket could not tell us anything" warrant different responses:
#
#     pass     — continue.
#     findings — the scan ran and the report is unhealthy. Prompt when
#                interactive; warn and continue when not, matching the audit and
#                Shai Hulud layers.
#     failure  — the scan could not run (no token, network/API error, crash).
#                Warn and continue by default: Socket is an opt-in third layer
#                and the CVE + supply chain layers have already run, so an
#                expired token or an offline laptop should not break installs.
#
#   SAFE_PNPM_SOCKET_STRICT=1 turns both findings and failures into hard blocks,
#   which is the setting for CI, where "the scan never ran" must not silently
#   look like a pass.
_safe_pkg_socket_scan() {
  local interactive="$1"
  local strict=0
  [ "${SAFE_PNPM_SOCKET_STRICT:-}" = "1" ] && strict=1

  local socket_cmd="$HOME/.safe-pnpm/socket"
  local classifier="$HOME/.safe-pnpm/socket-classify.js"

  if [ ! -f "$socket_cmd" ] || [ ! -f "$classifier" ]; then
    # The scan was explicitly requested but cannot run at all.
    if [ "$strict" -eq 1 ]; then
      echo "✗ Socket scan requested but not installed — run \`safe-pnpm setup\` (SAFE_PNPM_SOCKET_STRICT=1)." >&2
      return 1
    fi
    echo "⚠️  Socket scan requested but not installed — skipping. Run \`safe-pnpm setup\`." >&2
    return 0
  fi

  echo "→ Socket behavioral scan..." >&2

  local out rc verdict reason
  out=$(mktemp)
  # --report waits for the scan to finish and applies the org policy; without it
  # `scan create` only uploads the manifest and can never surface findings.
  "$socket_cmd" scan create . --report --json --no-spinner --no-banner \
    >"$out" 2>/dev/null
  rc=$?

  reason=$(node "$classifier" "$out" "$rc" 2>&1)
  verdict=$?
  rm -f "$out"

  case "$verdict" in
    0)
      return 0
      ;;
    3)
      if [ "$strict" -eq 1 ]; then
        echo "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." >&2
        return 1
      fi
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  %s Continue anyway? [y/N] " "$reason" >&2
        read -r _ans
        case "$_ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
      fi
      echo "⚠️  $reason Continuing in non-interactive mode." >&2
      return 0
      ;;
    *)
      if [ "$strict" -eq 1 ]; then
        echo "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." >&2
        return 1
      fi
      # A failed scan is not evidence of a problem, so it never prompts — it
      # only tells the user the layer did not run.
      echo "⚠️  $reason Continuing without Socket results." >&2
      return 0
      ;;
  esac
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

# _safe_pkg_strip_npmrc_auth path
#   Remove only credential-bearing lines from a copied .npmrc, leaving registry
#   URLs, scopes and hoisting config intact. Used between the fetch and build
#   phases so build-time lifecycle scripts never see a registry token.
_safe_pkg_strip_npmrc_auth() {
  local f="$1"
  [ -f "$f" ] || return 0
  # Matches _authToken, _auth, _password, and username lines in any scope/host
  # form (e.g. //registry.example.com/:_authToken=...).
  grep -viE '(_authtoken|_auth|_password|username)[[:space:]]*=' "$f" > "$f.clean" 2>/dev/null || : > "$f.clean"
  mv "$f.clean" "$f"
}

# _safe_pkg_run manager lockfile workspace_file manifest_files [pkg-manager-args...]
#   manager        — binary name (pnpm, npm, yarn)
#   lockfile       — lock file name (e.g. pnpm-lock.yaml)
#   workspace_file — sidecar workspace file to walk up for, or "" for none
#   manifest_files — space-separated list of files to copy into the sandbox
#   remaining args — passed through to the package manager inside Docker
#
# Two-phase isolation:
#   Phase 1 (fetch)  — network on, registry token available, --ignore-scripts.
#                      Resolves and downloads every dependency into a store under
#                      /app. No package code runs, so the token cannot leak.
#   Phase 2 (build)  — network off (--network none), token gone, .npmrc auth
#                      lines stripped. Lifecycle/build scripts run here against
#                      the already-populated store, with nothing left to steal.
#   Set SAFE_PNPM_BUILD_NETWORK=1 to keep network in phase 2 for packages whose
#   build genuinely needs it (e.g. esbuild, sharp); the token is still withheld.
_safe_pkg_run() {
  # zsh does not word-split unquoted parameters by default; the manifest list
  # ($manifest_files) and the docker flag lists below all rely on sh-style
  # splitting. localoptions reverts this when the function returns.
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split

  local manager="$1"
  local lockfile="$2"
  local workspace_file="$3"
  local manifest_files="$4"
  shift 4
  local subcmd="${1:-}"

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

  # Per-manager store/cache kept under /app so phase 2 resolves fully offline,
  # plus the phase-1 fetch flags and the phase-2 build command.
  local store_flag phase2_cmd
  case "$manager" in
    pnpm) store_flag="--config.store-dir=/app/.safe-store"
          phase2_cmd="install --offline --trust-lockfile $store_flag" ;;
    npm)  store_flag="--cache /app/.safe-store"
          phase2_cmd="rebuild $store_flag" ;;
    yarn) store_flag="--cache-folder /app/.safe-store"
          phase2_cmd="install --offline --force $store_flag" ;;
    *)    store_flag=""; phase2_cmd="" ;;
  esac

  # Tokens are forwarded only into the fetch phase, where --ignore-scripts
  # guarantees no package code runs. They are never present during phase 2.
  local token_env=""
  [ -n "${NODE_AUTH_TOKEN:-}" ] && token_env="$token_env -e NODE_AUTH_TOKEN"
  [ -n "${NPM_TOKEN:-}" ]       && token_env="$token_env -e NPM_TOKEN"

  # --- Phase 1: fetch (network on, token available, scripts disabled) ---
  # shellcheck disable=SC2086
  docker run --rm --cap-drop ALL \
    -v "${tmpdir}:/app" \
    -w "$workdir" \
    $token_env \
    safe-pnpm:latest "$manager" "$@" --ignore-scripts $store_flag
  local phase1_rc=$?
  local rc=$phase1_rc

  # pnpm `fetch` only populates the store and never builds node_modules; there
  # is nothing to run scripts for, so skip the build phase entirely.
  local run_build=1
  { [ "$manager" = "pnpm" ] && [ "$subcmd" = "fetch" ]; } && run_build=0

  if [ "$phase1_rc" -eq 0 ] && [ "$run_build" -eq 1 ] && [ -n "$phase2_cmd" ]; then
    # Strip registry credentials before any build script can run.
    _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"

    local net_flag="--network none"
    [ "${SAFE_PNPM_BUILD_NETWORK:-}" = "1" ] && net_flag=""

    # --- Phase 2: build (no token, no .npmrc auth, network off by default) ---
    # shellcheck disable=SC2086
    docker run --rm --cap-drop ALL $net_flag \
      -v "${tmpdir}:/app" \
      -w "$workdir" \
      safe-pnpm:latest "$manager" $phase2_cmd
    rc=$?
  fi

  # Copy results back whenever the fetch succeeded — the dependency tree exists
  # even if a build script later failed, and the non-zero rc still surfaces. A
  # failed fetch leaves a partial/empty tree, so nothing is copied there.
  if [ "$phase1_rc" -eq 0 ]; then
    if [ -d "$tmpdir/node_modules" ]; then
      rm -rf "${workspace_root}/node_modules"
      cp -r "$tmpdir/node_modules" "${workspace_root}/node_modules"
    fi
    [ -f "$tmpdir/$lockfile" ] && cp "$tmpdir/$lockfile" "${workspace_root}/$lockfile"
    # add/remove/update rewrite the manifest inside the sandbox; sync it back.
    [ -f "$tmpdir/package.json" ] && cp "$tmpdir/package.json" "${workspace_root}/package.json"
    if [ -n "$workspace_file" ] && [ -f "${workspace_root}/$workspace_file" ]; then
      find "$tmpdir" -mindepth 2 -name node_modules -type d -not -path "*/.safe-store/*" | while read -r nm; do
        rel="${nm#${tmpdir}/}"
        rm -rf "${workspace_root}/${rel}"
        mkdir -p "$(dirname "${workspace_root}/${rel}")"
        cp -r "$nm" "${workspace_root}/${rel}"
      done
      # Sync back any workspace-member manifests the command may have rewritten.
      find "$tmpdir" -mindepth 2 -name package.json -not -path "*/node_modules/*" -not -path "*/.safe-store/*" | while read -r pkg; do
        rel="${pkg#${tmpdir}/}"
        mkdir -p "$(dirname "${workspace_root}/${rel}")"
        cp "$pkg" "${workspace_root}/${rel}"
      done
    fi
  fi

  rm -rf "$tmpdir"
  return $rc
}
