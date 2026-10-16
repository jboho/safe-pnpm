# pnpm Docker isolation wrapper — fish shell
# Install: copy to ~/.config/fish/functions/pnpm.fish, and again as pnpx.fish
# (fish autoloads the pnpx function below only from a file of that name)
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: command pnpm install bypasses to native pnpm.

function pnpm
    # fish autoloads _safe_pkg_prescan.fish only by that name; it defines the
    # other _safe_pkg_ helpers, so load it before calling any of them, and
    # refuse the command when it is missing.
    functions -q _safe_pkg_prescan
    or begin
        echo "✗ safe-pnpm: _safe_pkg_prescan.fish not installed — run `safe-pnpm update`." >&2
        return 1
    end
    _safe_pkg_runner_check pnpm $argv
    or return 1

    # Walk the non-flag words: an install word or alias is the subcommand, a
    # known non-install command means native, and anything else may be the value
    # of a flag missing from value_flags, so try the next word (fails closed).
    # The value of a listed flag or a directory flag is skipped, unless it is an
    # install word or a flag. See _safe_pkg_subcmd in _safe_pkg_shared.sh.
    set -l install_cmds install i add update up upgrade ci clean-install ic install-clean fetch remove rm un uninstall uni install-test it unlink dislink
    set -l native_cmds run exec dlx test t start stop restart publish pack list ls ll la why outdated audit config c get set init create link ln rebuild rb approve-builds store root bin patch patch-commit patch-remove import prune dedupe deploy licenses help env self-update setup doctor server cat-file cat-index find-hash
    set -l value_flags (_safe_pkg_valueflags pnpm)
    set -l ninstall (string replace -a - '' -- $install_cmds)
    set -l nnative (string replace -a - '' -- $native_cmds)
    set -l subcmd
    set -l seen 0
    set -l skip 0
    for a in $argv
        if string match -q -- '-*=*' $a
            set skip 0
        else if string match -q -- '-*' $a
            set skip 0
            if contains -- $a $value_flags
                set skip 1
            else if functions -q _safe_pkg_dir_flag
                _safe_pkg_dir_flag pnpm $a >/dev/null
                test $status -ne 1; and set skip 1
            else
                set skip 1
            end
        else
            set -l n (string lower -- $a | string replace -a - '')
            test -z "$n"; and continue
            set -l inst 0
            contains -- $n $ninstall; and set inst 1
            if test $skip -eq 1
                set skip 0
                test $inst -eq 1; or continue
            end
            set seen 1
            if contains -- $n $nnative
                break
            else if test $inst -eq 1
                set subcmd $n
                break
            end
        end
    end
    if test -z "$subcmd"
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

    # An older _safe_pkg_prescan.fish lacks some of the checks below, and each
    # would then be an unknown command that lets the install through.
    if not functions -q _safe_pkg_prescan _safe_pkg_is_global _safe_pkg_dir_flag
        echo "✗ safe-pnpm: _safe_pkg_prescan.fish is missing or out of date; run safe-pnpm update." >&2
        return 1
    end

    # npm, pnpm and yarn stop reading flags at --, and npm and pnpm at any
    # longer run of dashes too.
    set -l dashes (string match -r -- '^-{2,}$' $pass_args)[1]
    if test -n "$dashes"
        echo "✗ safe-pnpm: $dashes is not supported through the wrapper; the sandbox adds --ignore-scripts and its other flags after your arguments, and after $dashes they would not be read as flags." >&2
        echo "  To run it without the safety checks: command pnpm "(string join ' ' -- (string escape -- $pass_args)) >&2
        return 1
    end

    if _safe_pkg_is_global $pass_args
        echo "✗ safe-pnpm: global installs are not supported through the wrapper; the sandbox would install into a throwaway container and change nothing on this machine." >&2
        echo "  To install globally without the safety checks, run: command pnpm "(string join ' ' -- (string escape -- $pass_args)) >&2
        return 1
    end

    set -l dir_flag (_safe_pkg_dir_flag pnpm $pass_args)
    set -l dir_status $status
    if test $dir_status -gt 1
        echo "✗ safe-pnpm: the directory-flag check failed (status $dir_status); run safe-pnpm update." >&2
        return 1
    else if test $dir_status -eq 0
        echo "✗ safe-pnpm: $dir_flag is not supported through the wrapper; the scan checks this directory's lockfile, so an install in another directory would go unchecked." >&2
        echo "  cd into that directory and run the command there. To run it without the safety checks: command pnpm "(string join ' ' -- (string escape -- $pass_args)) >&2
        return 1
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

    set -l lockfile_setting (_safe_pkg_lockfile_dir_setting $tmpdir)
    if test $status -ne 1
        if set -q lockfile_setting[2]
            echo "✗ safe-pnpm: $workspace_root/$lockfile_setting[1] sets $lockfile_setting[2], so pnpm would write the lockfile somewhere other than the one the scan checks. Remove the setting and run the command again." >&2
        else
            echo "✗ safe-pnpm: the lockfile-dir check failed; run safe-pnpm update." >&2
        end
        _safe_pkg_untrack $tmpdir $snapdir
        return 1
    end

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

    _safe_pkg_host_platform pnpm $tmpdir $snapdir/arch-saved.json

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
        _safe_pkg_pnpm_arch_restore $snapdir/tree/package.json $snapdir/arch-saved.json
        or set rc 1
    end

    if test $rc -eq 0
        # CVE audit on the resolved tree, after the snapshot and before any
        # build script. A block discards the sandbox like a malware hit does.
        _safe_pkg_audit pnpm pnpm-lock.yaml $snapdir/tree $tmpdir
        or set rc 1
    end

    if test $rc -eq 0
        # `pnpm fetch` only populates the store; there is nothing to build.
        if test "$subcmd" != "fetch"
            # Strip registry credentials before any build script can run.
            _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
            _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

            set -l net_flag --network none
            if test "$SAFE_PNPM_BUILD_NETWORK" = 1
                set net_flag
            end

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w $workdir \
                safe-pnpm:latest pnpm install --offline --config.trust-lockfile=true $store_flag
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

# pnpx is pnpm dlx: same OSV check, then native.
# setup also installs this file as pnpx.fish, so fish autoloads it for pnpx.
function pnpx
    functions -q _safe_pkg_prescan
    or begin
        echo "✗ safe-pnpm: _safe_pkg_prescan.fish not installed — run `safe-pnpm update`." >&2
        return 1
    end
    _safe_pkg_runner_check pnpx $argv
    or return 1
    command pnpx $argv
end

# On a disk that ignores case (macOS by default) fish finds the real program
# under any spelling of its name, and autoloads this file for it too, so
# every other spelling runs the wrapper.
for _safe_pkg_n in PNPM PNPm PNpM PNpm PnPM PnPm PnpM Pnpm pNPM pNPm pNpM pNpm pnPM pnPm pnpM
    function $_safe_pkg_n --wraps pnpm
        pnpm $argv
    end
end
for _safe_pkg_n in PNPX PNPx PNpX PNpx PnPX PnPx PnpX Pnpx pNPX pNPx pNpX pNpx pnPX pnPx pnpX
    function $_safe_pkg_n --wraps pnpx
        pnpx $argv
    end
end
set -e _safe_pkg_n
