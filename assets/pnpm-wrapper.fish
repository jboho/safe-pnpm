# pnpm Docker isolation wrapper — fish shell
# Install: copy to ~/.config/fish/functions/pnpm.fish
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: command pnpm install bypasses to native pnpm.

function pnpm
    set -l install_cmds install add update ci remove fetch
    if not contains -- $argv[1] $install_cmds
        command pnpm $argv
        return
    end

    # Extract the safe-pnpm-only `--socket` flag so it never reaches pnpm.
    set -l socket_flag 0
    set -l pass_args
    for a in $argv
        if test "$a" = "--socket"
            set socket_flag 1
        else
            set pass_args $pass_args $a
        end
    end

    _safe_pkg_prescan pnpm pnpm-lock.yaml $socket_flag
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native pnpm? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command pnpm $pass_args
            else
                return 1
            end
        else if test "$SAFE_PNPM_ALLOW_NATIVE_FALLBACK" = 1
            echo "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native pnpm." >&2
            command pnpm $pass_args
        else
            echo "✗ safe-pnpm: Docker not running and no TTY — refusing native pnpm (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." >&2
            return 1
        end
        return
    end

    set -l workspace_root (pwd)
    set -l rel_path ""
    set -l d (pwd)
    while test "$d" != "$HOME"; and test "$d" != "/"
        if test -f "$d/pnpm-workspace.yaml"
            set workspace_root $d
            set rel_path (string replace -- "$d" "" (pwd) | string trim --left --chars=/)
            break
        end
        set d (dirname $d)
    end

    set -l tmpdir (mktemp -d)

    pushd $workspace_root
    for f in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc
        if test -f $f
            cp $f $tmpdir/
        end
    end
    if test -f pnpm-workspace.yaml
        for pkg in (find . -name package.json -not -path "*/node_modules/*" -mindepth 2)
            set -l pkg_dir $tmpdir/(dirname $pkg)
            mkdir -p $pkg_dir
            cp $pkg $pkg_dir/
        end
    end
    popd

    set -l workdir /app
    if test -n "$rel_path"
        set workdir /app/$rel_path
    end

    # Per-manager store kept under /app so phase 2 resolves fully offline.
    set -l store_flag --config.store-dir=/app/.safe-store

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
    docker run --rm --cap-drop ALL -v "$tmpdir:/app" -w $workdir $token_env \
        safe-pnpm:latest pnpm $pass_args --ignore-scripts $store_flag
    set -l rc $status

    if test $rc -eq 0
        # `pnpm fetch` only populates the store; there is nothing to build.
        if test "$argv[1]" != "fetch"
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
            docker run --rm --cap-drop ALL $net_flag -v "$tmpdir:/app" -w $workdir \
                safe-pnpm:latest pnpm install --offline --trust-lockfile $store_flag
            set rc $status
        end

        if test -d "$tmpdir/node_modules"
            rm -rf "$workspace_root/node_modules"
            cp -r "$tmpdir/node_modules" "$workspace_root/node_modules"
        end
        if test -f "$tmpdir/pnpm-lock.yaml"
            cp "$tmpdir/pnpm-lock.yaml" "$workspace_root/pnpm-lock.yaml"
        end
        if test -f "$workspace_root/pnpm-workspace.yaml"
            for nm in (find $tmpdir -mindepth 2 -name node_modules -type d -not -path "*/.safe-store/*")
                set -l rel (string replace -- "$tmpdir/" "" $nm)
                rm -rf "$workspace_root/$rel"
                mkdir -p (dirname "$workspace_root/$rel")
                cp -r $nm "$workspace_root/$rel"
            end
        end
    end

    rm -rf $tmpdir
    return $rc
end
