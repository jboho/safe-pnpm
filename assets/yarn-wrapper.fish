# yarn Docker isolation wrapper — fish shell
# Install: copy to ~/.config/fish/functions/yarn.fish
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class yarn commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: command yarn install bypasses to native yarn.
# Note: yarn v1 only. berry (v2+) requires separate handling.

function yarn
    set -l install_cmds install add remove upgrade
    if not contains -- $argv[1] $install_cmds
        command yarn $argv
        return
    end

    # Extract the safe-pnpm-only `--socket` flag so it never reaches yarn.
    set -l socket_flag 0
    set -l pass_args
    for a in $argv
        if test "$a" = "--socket"
            set socket_flag 1
        else
            set pass_args $pass_args $a
        end
    end

    _safe_pkg_prescan yarn yarn.lock $socket_flag
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native yarn? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command yarn $pass_args
            else
                return 1
            end
        else if test "$SAFE_PNPM_ALLOW_NATIVE_FALLBACK" = 1
            echo "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native yarn." >&2
            command yarn $pass_args
        else
            echo "✗ safe-pnpm: Docker not running and no TTY — refusing native yarn (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." >&2
            return 1
        end
        return
    end

    # Both containers run as the invoking user, not root (except under rootless
    # Docker or Podman, see _safe_pkg_docker_rootless). Files they create in
    # the sandbox are then owned by that user, so cleanup can delete them on
    # Linux (Docker Desktop on macOS hides root ownership), and a process that
    # escapes the container is an ordinary user. The image has no home dir for
    # an arbitrary uid, so HOME points inside the sandbox mount.
    set -l user_flags (_safe_pkg_user_flags)
    or return 1

    set -l tmpdir (mktemp -d)
    # Host-only, never mounted into a container: the post-fetch manifest
    # snapshots that copy-back reads from.
    set -l snapdir (mktemp -d)
    _safe_pkg_track $tmpdir $snapdir

    for f in package.json yarn.lock .yarnrc .npmrc
        if test -f $f
            cp $f $tmpdir/
        end
    end

    # Per-manager cache kept under /app so phase 2 resolves fully offline.
    set -l store_flag --cache-folder /app/.safe-store

    # Tokens are forwarded only into the fetch phase, where --ignore-scripts
    # guarantees no package code runs. They are never present during phase 2.
    set -l token_env
    if test -n "$NODE_AUTH_TOKEN"
        set token_env $token_env -e NODE_AUTH_TOKEN
    end
    if test -n "$NPM_TOKEN"
        set token_env $token_env -e NPM_TOKEN
    end

    # Limits for both containers: no setuid escalation and a bounded process
    # count (a fork bomb in a build script would otherwise take down the Docker
    # VM). Memory is opt-in because legitimate builds vary widely in what they need.
    set -l hardening --security-opt no-new-privileges --pids-limit 1024
    if test -n "$SAFE_PNPM_MEMORY"
        set hardening $hardening --memory $SAFE_PNPM_MEMORY
    end

    # Phase 2 needs the flag too, or --force would prune what phase 1 added.
    set -l host_flags (_safe_pkg_host_platform yarn $tmpdir)

    # Phase 1: fetch (network on, token available, scripts disabled).
    docker run --rm --cap-drop ALL $hardening $user_flags -v "$tmpdir:/app" -w /app $token_env \
        safe-pnpm:latest yarn $pass_args --ignore-scripts $store_flag $host_flags
    set -l rc $status

    # Known-malware check on the tree phase 1 resolved, before any package
    # code runs. A hit discards the sandbox: nothing is built or copied back.
    if test $rc -eq 0
        _safe_pkg_malware_scan "$tmpdir/yarn.lock"
        or set rc 1
    end

    if test $rc -eq 0
        # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
        # code, so these hold only the package manager's own edits. Phase 2
        # build scripts can rewrite anything under /app; a rewritten
        # package.json script or lockfile URL would run natively on the next
        # host command, so copy-back reads manifests from here, never from the
        # sandbox.
        for f in package.json yarn.lock
            if test -f "$tmpdir/$f"
                cp "$tmpdir/$f" "$snapdir/$f"
            end
        end

        # CVE audit on the resolved tree, after the snapshot and before any
        # build script. A block discards the sandbox like a malware hit does.
        _safe_pkg_audit yarn yarn.lock $snapdir $tmpdir
        or set rc 1
    end

    if test $rc -eq 0
        # Strip registry credentials before any build script can run.
        _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
        _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

        set -l net_flag --network none
        if test "$SAFE_PNPM_BUILD_NETWORK" = 1
            set net_flag
        end

        # Phase 2: build (no token, no .npmrc auth, network off by default).
        docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w /app \
            safe-pnpm:latest yarn install --offline --force $store_flag $host_flags
        set rc $status

        # A node_modules swapped for a symlink could pull in files from anywhere
        # the link points; copy back only a plain directory.
        if test -L "$tmpdir/node_modules"; or begin; test -e "$tmpdir/node_modules"; and not test -d "$tmpdir/node_modules"; end
            echo "✗ safe-pnpm: sandbox node_modules is not a plain directory; not copied back." >&2
            set rc 1
        else if test -d "$tmpdir/node_modules"
            if _safe_pkg_links_ok $tmpdir node_modules
                rm -rf node_modules
                cp -R "$tmpdir/node_modules" node_modules
            else
                set rc 1
            end
        end
        for f in package.json yarn.lock
            if test -f "$snapdir/$f"
                cp "$snapdir/$f" $f
            end
        end
    end

    _safe_pkg_untrack $tmpdir $snapdir
    return $rc
end
