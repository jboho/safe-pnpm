# npm Docker isolation wrapper — fish shell
# Install: copy to ~/.config/fish/functions/npm.fish
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: command npm install bypasses to native npm.

function npm
    set -l install_cmds install i ci update uninstall un
    if not contains -- $argv[1] $install_cmds
        command npm $argv
        return
    end

    # Extract the safe-pnpm-only `--socket` flag so it never reaches npm.
    set -l socket_flag 0
    set -l pass_args
    for a in $argv
        if test "$a" = "--socket"
            set socket_flag 1
        else
            set pass_args $pass_args $a
        end
    end

    _safe_pkg_prescan npm package-lock.json $socket_flag
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native npm? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command npm $pass_args
            else
                return 1
            end
        else if test "$SAFE_PNPM_ALLOW_NATIVE_FALLBACK" = 1
            echo "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native npm." >&2
            command npm $pass_args
        else
            echo "✗ safe-pnpm: Docker not running and no TTY — refusing native npm (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." >&2
            return 1
        end
        return
    end

    set -l tmpdir (mktemp -d)
    # Host-only, never mounted into a container: the post-fetch manifest
    # snapshots that copy-back reads from.
    set -l snapdir (mktemp -d)

    for f in package.json package-lock.json .npmrc
        if test -f $f
            cp $f $tmpdir/
        end
    end

    # Per-manager cache kept under /app so phase 2 resolves fully offline.
    set -l store_flag --cache /app/.safe-store

    # Tokens are forwarded only into the fetch phase, where --ignore-scripts
    # guarantees no package code runs. They are never present during phase 2.
    set -l token_env
    if test -n "$NODE_AUTH_TOKEN"
        set token_env $token_env -e NODE_AUTH_TOKEN
    end
    if test -n "$NPM_TOKEN"
        set token_env $token_env -e NPM_TOKEN
    end

    # Phase 1: fetch (network on, token available, scripts disabled).
    docker run --rm --cap-drop ALL -v "$tmpdir:/app" -w /app $token_env \
        safe-pnpm:latest npm $pass_args --ignore-scripts $store_flag
    set -l rc $status

    # Known-malware check on the tree phase 1 resolved, before any package
    # code runs. A hit discards the sandbox: nothing is built or copied back.
    if test $rc -eq 0
        _safe_pkg_malware_scan "$tmpdir/package-lock.json"
        or set rc 1
    end

    if test $rc -eq 0
        # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
        # code, so these hold only the package manager's own edits. Phase 2
        # build scripts can rewrite anything under /app; a rewritten
        # package.json script or lockfile URL would run natively on the next
        # host command, so copy-back reads manifests from here, never from the
        # sandbox.
        for f in package.json package-lock.json
            if test -f "$tmpdir/$f"
                cp "$tmpdir/$f" "$snapdir/$f"
            end
        end

        # Strip registry credentials before any build script can run.
        if test -f "$tmpdir/.npmrc"
            grep -viE '(_authtoken|_auth|_password|username)[[:space:]]*=' "$tmpdir/.npmrc" >"$tmpdir/.npmrc.clean" 2>/dev/null
            mv "$tmpdir/.npmrc.clean" "$tmpdir/.npmrc"
        end

        set -l net_flag --network none
        if test "$SAFE_PNPM_BUILD_NETWORK" = 1
            set net_flag
        end

        # Phase 2: build (no token, no .npmrc auth, network off by default).
        docker run --rm --cap-drop ALL $net_flag -v "$tmpdir:/app" -w /app \
            safe-pnpm:latest npm rebuild $store_flag
        set rc $status

        # A node_modules swapped for a symlink could pull in files from anywhere
        # the link points; copy back only a plain directory.
        if test -L "$tmpdir/node_modules"; or begin; test -e "$tmpdir/node_modules"; and not test -d "$tmpdir/node_modules"; end
            echo "✗ safe-pnpm: sandbox node_modules is not a plain directory; not copied back." >&2
            set rc 1
        else if test -d "$tmpdir/node_modules"
            rm -rf node_modules
            cp -r "$tmpdir/node_modules" node_modules
        end
        for f in package.json package-lock.json
            if test -f "$snapdir/$f"
                cp "$snapdir/$f" $f
            end
        end
    end

    rm -rf $tmpdir $snapdir
    return $rc
end
