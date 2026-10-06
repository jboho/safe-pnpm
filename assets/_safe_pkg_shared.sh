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
    # Output is kept and shown on failure: a non-zero exit means either
    # advisories or that the audit itself could not run (offline, registry
    # error), and the user needs the text to tell which.
    local audit_out audit_rc
    audit_out=$(mktemp) || return 1
    case "$manager" in
      pnpm) command pnpm audit --audit-level moderate >"$audit_out" 2>&1 ;;
      npm)  command npm  audit --audit-level moderate >"$audit_out" 2>&1 ;;
      yarn) command yarn audit >"$audit_out" 2>&1 ;;
    esac
    audit_rc=$?
    if [ "$audit_rc" -ne 0 ]; then
      tail -n 40 "$audit_out" >&2
      if [ "${SAFE_PNPM_STRICT:-}" = "1" ]; then
        rm -f "$audit_out"
        echo "✗ $manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." >&2
        return 1
      fi
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  %s audit failed or found issues. Continue anyway? [y/N] " "$manager" >&2
        read -r _ans
        case "$_ans" in [Yy]*) ;; *) rm -f "$audit_out"; return 1 ;; esac
      else
        echo "⚠️  $manager audit failed or found issues — continuing in non-interactive mode." >&2
      fi
    fi
    rm -f "$audit_out"
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
#                interactive; warn and continue when not, matching the audit
#                layer.
#     failure  — the scan could not run (no token, network/API error, crash).
#                Warn and continue by default: Socket is an opt-in layer on
#                top of the audit and malware scans, so an expired token or an
#                offline laptop should not break installs.
#
#   SAFE_PNPM_SOCKET_STRICT=1 turns both findings and failures into hard blocks,
#   which is the setting for CI, where "the scan never ran" must not silently
#   look like a pass.
_safe_pkg_socket_scan() {
  local interactive="$1"
  local strict=0
  [ "${SAFE_PNPM_SOCKET_STRICT:-}" = "1" ] && strict=1
  [ "${SAFE_PNPM_STRICT:-}" = "1" ] && strict=1

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

# _safe_pkg_malware_scan lockfile
#   Checks every name@version in the lockfile the fetch phase resolved against
#   OSV's malicious-package advisories (malware-scan.js). It runs between the
#   phases, so no package code has run yet and packages being added in this
#   install are covered, not just the ones already locked.
#
#     pass     — continue.
#     findings — always block. A MAL- advisory marks that exact version as
#                malware; unlike an audit finding there is nothing to weigh.
#     failure  — the scan could not run (OSV unreachable, unreadable lockfile,
#                scanner not installed). Warn and continue, as the Socket layer
#                does; SAFE_PNPM_OSV_STRICT=1 blocks instead, for CI.
_safe_pkg_malware_scan() {
  local lockfile="$1"
  local scanner="$HOME/.safe-pnpm/malware-scan.js"
  local reason verdict

  if [ -f "$scanner" ]; then
    echo "→ Malware scan (OSV)..." >&2
    reason=$(node "$scanner" "$lockfile" 2>&1)
    verdict=$?
  else
    reason="Malware scan not installed — run \`safe-pnpm setup\`."
    verdict=4
  fi

  case "$verdict" in
    0)
      echo "✓ $reason" >&2
      return 0
      ;;
    3)
      echo "✗ $reason" >&2
      echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
      return 1
      ;;
  esac
  if [ "${SAFE_PNPM_OSV_STRICT:-}" = "1" ]; then
    echo "✗ $reason Blocking (SAFE_PNPM_OSV_STRICT=1)." >&2
    return 1
  fi
  if [ "${SAFE_PNPM_STRICT:-}" = "1" ]; then
    echo "✗ $reason Blocking (SAFE_PNPM_STRICT=1)." >&2
    return 1
  fi
  echo "⚠️  $reason Continuing without it." >&2
  return 0
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
  # .yarnrc (v1) writes `_authToken "x"` with no `=`; .yarnrc.yml uses
  # npmAuthToken/npmAuthIdent keys with `:`.
  grep -viE '(_authtoken|_auth|_password|username|npmauthtoken|npmauthident)[[:space:]]*[=:"[:space:]]' "$f" > "$f.clean" 2>/dev/null || : > "$f.clean"
  mv "$f.clean" "$f"
}

# Under rootless Docker or Podman, container uid 0 maps to the invoking user
# but any other uid maps to a subordinate uid, so files the container writes
# into the bind-mounted sandbox could not be deleted by that user. There the
# containers keep their default user: root in them is unprivileged on the
# host. Rootless iff SecurityOptions lists "name=rootless". Only when that
# query fails (Podman's own CLI has no such field) is Podman's
# Host.Security.Rootless asked. An unreadable answer counts as not rootless,
# so --user stays the default.
_safe_pkg_docker_rootless() {
  local opts podman
  if opts=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null); then
    case "$opts" in *'"name=rootless"'*) return 0 ;; esac
    return 1
  fi
  podman=$(docker info --format '{{.Host.Security.Rootless}}' 2>/dev/null) || return 1
  podman=${podman#"${podman%%[![:space:]]*}"}
  podman=${podman%"${podman##*[![:space:]]}"}
  [ "$podman" = "true" ]
}

# Prints the flags that make both containers run as the invoking user.
# `command id` skips any alias or function named id, and a non-numeric
# result is refused: docker reads `--user :` as root.
_safe_pkg_user_flags() {
  local u g
  u=$(command id -u 2>/dev/null); g=$(command id -g 2>/dev/null)
  case "$u" in ''|*[!0-9]*) u="" ;; esac
  case "$g" in ''|*[!0-9]*) g="" ;; esac
  if [ -z "$u" ] || [ -z "$g" ]; then
    echo "✗ safe-pnpm: could not read your user id (id -u / id -g); refusing to run the install container as root." >&2
    return 1
  fi
  if _safe_pkg_docker_rootless; then return 0; fi
  echo "--user $u:$g -e HOME=/app/.safe-home"
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

  local tmpdir snapdir
  tmpdir=$(mktemp -d) || return 1
  # Host-only, never mounted into a container: the workspace-member list and
  # the post-fetch manifest snapshots that copy-back reads from.
  snapdir=$(mktemp -d) || { rm -rf "$tmpdir"; return 1; }

  # tmpdir holds a copy of .npmrc (registry token). Run the sandbox in a
  # subshell whose EXIT trap removes both dirs, so Ctrl-C or a kill cannot
  # leave the token on disk. A trap in this function would be global in bash.
  (
    # Expanded now, not at trap time: bash unwinds the function's locals before
    # the EXIT trap fires, so a late $tmpdir would be empty and rm a no-op.
    trap "rm -rf '$tmpdir' '$snapdir'" EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    _safe_pkg_sandbox "$tmpdir" "$snapdir" "$manager" "$lockfile" "$workspace_file" "$manifest_files" "$@"
  )
}

# _safe_pkg_sandbox tmpdir snapdir manager lockfile workspace_file manifest_files [args...]
#   Body of _safe_pkg_run; tmpdir/snapdir are created and removed by the caller.
_safe_pkg_sandbox() {
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split

  local tmpdir="$1" snapdir="$2" manager="$3" lockfile="$4" workspace_file="$5" manifest_files="$6"
  shift 6
  local subcmd="${1:-}"

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

  : > "$snapdir/members"

  (
    cd "$workspace_root" || exit 1
    for f in $manifest_files; do
      [ -f "$f" ] && cp "$f" "$tmpdir/"
    done
    if [ -n "$workspace_file" ] && [ -f "$workspace_file" ]; then
      find . -name package.json -not -path "*/node_modules/*" -mindepth 2 | while read -r pkg; do
        member="$(dirname "${pkg#./}")"
        mkdir -p "$tmpdir/$member"
        cp "$pkg" "$tmpdir/$member/"
        printf '%s\n' "$member" >> "$snapdir/members"
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

  # Limits for both containers: no setuid escalation and a bounded process
  # count (a fork bomb in a build script would otherwise take down the Docker
  # VM). Memory is opt-in because legitimate builds vary widely in what they need.
  local hardening="--security-opt no-new-privileges --pids-limit 1024"
  [ -n "${SAFE_PNPM_MEMORY:-}" ] && hardening="$hardening --memory ${SAFE_PNPM_MEMORY}"

  # Both containers run as the invoking user, not root (except under rootless
  # Docker or Podman, see _safe_pkg_docker_rootless). Files they create in
  # the sandbox are then owned by that user, so cleanup can delete them on
  # Linux (Docker Desktop on macOS hides root ownership), and a process that
  # escapes the container is an ordinary user. The image has no home dir for
  # an arbitrary uid, so HOME points inside the sandbox mount.
  local user_flags
  user_flags=$(_safe_pkg_user_flags) || return 1

  # Tokens are forwarded only into the fetch phase, where --ignore-scripts
  # guarantees no package code runs. They are never present during phase 2.
  local token_env=""
  [ -n "${NODE_AUTH_TOKEN:-}" ] && token_env="$token_env -e NODE_AUTH_TOKEN"
  [ -n "${NPM_TOKEN:-}" ]       && token_env="$token_env -e NPM_TOKEN"

  # --- Phase 1: fetch (network on, token available, scripts disabled) ---
  # shellcheck disable=SC2086
  docker run --rm --cap-drop ALL $hardening $user_flags \
    -v "${tmpdir}:/app" \
    -w "$workdir" \
    $token_env \
    safe-pnpm:latest "$manager" "$@" --ignore-scripts $store_flag
  local phase1_rc=$?
  local rc=$phase1_rc

  # Known-malware check on the tree phase 1 resolved, before any package code
  # runs. A hit discards the sandbox: nothing is built or copied back.
  local fetched=0
  if [ "$phase1_rc" -eq 0 ]; then
    if _safe_pkg_malware_scan "$tmpdir/$lockfile"; then
      fetched=1
    else
      rc=1
    fi
  fi

  # pnpm `fetch` only populates the store and never builds node_modules; there
  # is nothing to run scripts for, so skip the build phase entirely.
  local run_build=1
  { [ "$manager" = "pnpm" ] && [ "$subcmd" = "fetch" ]; } && run_build=0

  # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
  # code, so these hold only the package manager's own edits (add/remove/
  # update). Phase 2 build scripts can rewrite anything under /app; a rewritten
  # package.json script or lockfile URL would run natively on the next host
  # command, so copy-back reads manifests from here, never from the sandbox.
  local m f
  if [ "$fetched" -eq 1 ]; then
    mkdir -p "$snapdir/tree"
    for f in package.json "$lockfile"; do
      [ -f "$tmpdir/$f" ] && cp "$tmpdir/$f" "$snapdir/tree/$f"
    done
    while IFS= read -r m; do
      if [ -f "$tmpdir/$m/package.json" ]; then
        mkdir -p "$snapdir/tree/$m"
        cp "$tmpdir/$m/package.json" "$snapdir/tree/$m/package.json"
      fi
    done < "$snapdir/members"
  fi

  if [ "$fetched" -eq 1 ] && [ "$run_build" -eq 1 ] && [ -n "$phase2_cmd" ]; then
    # Strip registry credentials before any build script can run.
    _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
    _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

    local net_flag="--network none"
    [ "${SAFE_PNPM_BUILD_NETWORK:-}" = "1" ] && net_flag=""

    # --- Phase 2: build (no token, no .npmrc auth, network off by default) ---
    # shellcheck disable=SC2086
    docker run --rm --cap-drop ALL $hardening $user_flags $net_flag \
      -v "${tmpdir}:/app" \
      -w "$workdir" \
      safe-pnpm:latest "$manager" $phase2_cmd
    rc=$?
  fi

  # Copy results back whenever the fetch succeeded and passed the malware scan —
  # the dependency tree exists even if a build script later failed, and the
  # non-zero rc still surfaces. A failed fetch leaves a partial/empty tree, so
  # nothing is copied there.
  # Only node_modules at the root and in pre-existing workspace members come
  # back, so phase 2 cannot plant node_modules elsewhere in the project.
  if [ "$fetched" -eq 1 ]; then
    _safe_pkg_copy_modules "$tmpdir" "" "$workspace_root" || rc=1
    while IFS= read -r m; do
      _safe_pkg_copy_modules "$tmpdir" "$m" "$workspace_root" || rc=1
    done < "$snapdir/members"
    for f in package.json "$lockfile"; do
      [ -f "$snapdir/tree/$f" ] && cp "$snapdir/tree/$f" "${workspace_root}/$f"
    done
    while IFS= read -r m; do
      [ -f "$snapdir/tree/$m/package.json" ] && cp "$snapdir/tree/$m/package.json" "${workspace_root}/$m/package.json"
    done < "$snapdir/members"
  fi

  return $rc
}

# _safe_pkg_copy_modules tmpdir member workspace_root
#
# Copies <tmpdir>/<member>/node_modules to the same place under workspace_root
# (member "" is the root). The sandbox tree is untrusted after phase 2, so the
# source must resolve to exactly that path: a node_modules, or a member dir,
# swapped for a symlink could otherwise pull in files from anywhere the link
# points. Returns 1 when it refuses.
#
# Links inside node_modules are copied as links (-R): pnpm's layout is built
# from them. macOS `cp -r` (undocumented there) follows links instead, turning
# each package into a plain copy cut off from its dependencies in .pnpm/, so
# the first import of one fails. Linux `cp -r` keeps links, so Linux CI never
# showed this. Kept links must stay inside the project; see link-check.js.
_safe_pkg_copy_modules() {
  local base="$1" member="$2" dest_root="$3"
  local rel="${member:+$member/}node_modules"
  local src="$base/$rel"
  [ -e "$src" ] || [ -L "$src" ] || return 0
  local want got
  want="$(cd "$base" && pwd -P)/$rel"
  got="$(cd "$src" 2>/dev/null && pwd -P)"
  if [ ! -d "$src" ] || [ -L "$src" ] || [ "$got" != "$want" ]; then
    echo "✗ safe-pnpm: sandbox $rel is not a plain directory; not copied back." >&2
    return 1
  fi
  _safe_pkg_links_ok "$base" "$rel" || return 1
  rm -rf "${dest_root:?}/$rel"
  cp -R "$src" "${dest_root}/$rel"
}

# _safe_pkg_links_ok base rel
#
# Fails closed: a missing checker or a tree it cannot read refuses copy-back.
_safe_pkg_links_ok() {
  local base="$1" rel="$2"
  local checker="$HOME/.safe-pnpm/link-check.js"
  if [ ! -f "$checker" ]; then
    echo "✗ safe-pnpm: link check not installed — run \`safe-pnpm update\`; $rel not copied back." >&2
    return 1
  fi
  if ! node "$checker" "$base" "$rel"; then
    echo "✗ safe-pnpm: sandbox $rel has links that point outside the project; not copied back." >&2
    return 1
  fi
}
