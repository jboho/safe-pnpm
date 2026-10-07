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
    set -l members

    pushd $workspace_root
    for f in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc
        if test -f $f
            cp $f $tmpdir/
        end
    end
    if test -f pnpm-workspace.yaml
        for pkg in (find . -name package.json -not -path "*/node_modules/*" -mindepth 2)
            set -l member (dirname (string replace -r '^\./' '' -- $pkg))
            mkdir -p $tmpdir/$member
            cp $pkg $tmpdir/$member/
            set members $members $member
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

    # Limits for both containers: no setuid escalation and a bounded process
    # count (a fork bomb in a build script would otherwise take down the Docker
    # VM). Memory is opt-in because legitimate builds vary widely in what they need.
    set -l hardening --security-opt no-new-privileges --pids-limit 1024
    if test -n "$SAFE_PNPM_MEMORY"
        set hardening $hardening --memory $SAFE_PNPM_MEMORY
    end

    # Phase 1: fetch (network on, token available, scripts disabled).
    docker run --rm --cap-drop ALL $hardening $user_flags -v "$tmpdir:/app" -w $workdir $token_env \
        safe-pnpm:latest pnpm $pass_args --ignore-scripts $store_flag
    set -l rc $status

    # Known-malware check on the tree phase 1 resolved, before any package
    # code runs. A hit discards the sandbox: nothing is built or copied back.
    if test $rc -eq 0
        _safe_pkg_malware_scan "$tmpdir/pnpm-lock.yaml"
        or set rc 1
    end

    if test $rc -eq 0
        # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
        # code, so these hold only the package manager's own edits. Phase 2
        # build scripts can rewrite anything under /app; a rewritten
        # package.json script or lockfile URL would run natively on the next
        # host command, so copy-back reads manifests from here, never from the
        # sandbox.
        mkdir -p $snapdir/tree
        for f in package.json pnpm-lock.yaml
            if test -f "$tmpdir/$f"
                cp "$tmpdir/$f" "$snapdir/tree/$f"
            end
        end
        for m in $members
            if test -f "$tmpdir/$m/package.json"
                mkdir -p "$snapdir/tree/$m"
                cp "$tmpdir/$m/package.json" "$snapdir/tree/$m/package.json"
            end
        end

        # CVE audit on the resolved tree, after the snapshot and before any
        # build script. A block discards the sandbox like a malware hit does.
        _safe_pkg_audit pnpm pnpm-lock.yaml $snapdir/tree $tmpdir
        or set rc 1
    end

    if test $rc -eq 0
        # `pnpm fetch` only populates the store; there is nothing to build.
        if test "$argv[1]" != "fetch"
            # Strip registry credentials before any build script can run.
            _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
            _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

            set -l net_flag --network none
            if test "$SAFE_PNPM_BUILD_NETWORK" = 1
                set net_flag
            end

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w $workdir \
                safe-pnpm:latest pnpm install --offline --trust-lockfile $store_flag
            set rc $status
        end

        # Only node_modules at the root and in pre-existing workspace members
        # come back, so phase 2 cannot plant node_modules elsewhere in the
        # project. A node_modules or member dir swapped for a symlink could
        # pull in files from anywhere the link points, so each source must
        # resolve to exactly its expected path.
        set -l real_tmp (path resolve $tmpdir)
        for m in "" $members
            set -l rel node_modules
            if test -n "$m"
                set rel $m/node_modules
            end
            set -l nm "$tmpdir/$rel"
            if not test -e "$nm"; and not test -L "$nm"
                continue
            end
            if test -L "$nm"; or not test -d "$nm"; or test (path resolve "$nm") != "$real_tmp/$rel"
                echo "✗ safe-pnpm: sandbox $rel is not a plain directory; not copied back." >&2
                set rc 1
                continue
            end
            if not _safe_pkg_links_ok $tmpdir $rel
                set rc 1
                continue
            end
            rm -rf "$workspace_root/$rel"
            cp -R "$nm" "$workspace_root/$rel"
        end
        for f in package.json pnpm-lock.yaml
            if test -f "$snapdir/tree/$f"
                cp "$snapdir/tree/$f" "$workspace_root/$f"
            end
        end
        for m in $members
            if test -f "$snapdir/tree/$m/package.json"
                cp "$snapdir/tree/$m/package.json" "$workspace_root/$m/package.json"
            end
        end
    end

    _safe_pkg_untrack $tmpdir $snapdir
    return $rc
end
