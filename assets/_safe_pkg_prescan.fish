# _safe_pkg_prescan.fish — shared prescan for safe-pnpm, safe-npm, safe-yarn (fish shell)
# Place in ~/.config/fish/functions/ — fish autoloads it when _safe_pkg_prescan is first called.

function _safe_pkg_prescan --argument manager lockfile socket_flag
    # Socket is opt-in: enable globally with SAFE_PNPM_ENABLE_SOCKET=1 or
    # per-invocation with `--socket`.
    set -l socket_enabled 0
    if test "$SAFE_PNPM_ENABLE_SOCKET" = "1"; or test "$socket_flag" = "1"
        set socket_enabled 1
    end
    if test "$socket_enabled" = "1"
        _safe_pkg_socket_scan
        or return 1
    end
end

# Runs the manager's CVE audit on the tree phase 1 resolved, so a package
# passed to `add` is covered. Returns 1 to block. See _safe_pkg_shared.sh for
# the full rationale. It runs on the host, so it audits a throwaway copy of the
# post-fetch snapshot plus the registry config (.npmrc from the sandbox, and
# .yarnrc without its yarn-path line), never the project. pnpm also skips the
# project's .pnpmfile.cjs, which would otherwise run on the host.
function _safe_pkg_audit --argument manager lockfile snapdir tmpdir
    test -f "$snapdir/$lockfile"; or return 0

    set -l auditdir (mktemp -d)
    or return 1
    set -l audit_out (mktemp)
    or begin
        rm -rf $auditdir
        return 1
    end
    cp -R "$snapdir/." "$auditdir/"
    test -f "$tmpdir/.npmrc"; and cp "$tmpdir/.npmrc" "$auditdir/.npmrc"
    if test -f "$tmpdir/.yarnrc"
        command grep -v '^[[:space:]]*"\{0,1\}yarn-path' "$tmpdir/.yarnrc" >"$auditdir/.yarnrc"
    end

    echo "→ $manager audit..." >&2
    # pushd/popd, not cd: a fish function shares the caller's working directory.
    pushd $auditdir >/dev/null
    or begin
        rm -rf $auditdir $audit_out
        return 1
    end
    switch $manager
        case pnpm
            command pnpm audit --audit-level moderate --config.ignore-pnpmfile=true >$audit_out 2>&1
        case npm
            command npm audit --audit-level moderate >$audit_out 2>&1
        case yarn
            command yarn audit >$audit_out 2>&1
    end
    set -l audit_rc $status
    popd >/dev/null
    rm -rf $auditdir

    if test $audit_rc -ne 0
        tail -n 40 $audit_out >&2
        if test "$SAFE_PNPM_STRICT" = "1"
            rm -f $audit_out
            echo "✗ $manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." >&2
            return 1
        end
        if isatty stdin
            read --prompt-str "⚠️  $manager audit failed or found issues. Continue anyway? [y/N] " _ans
            if not string match -qi 'y*' "$_ans"
                rm -f $audit_out
                return 1
            end
        else
            echo "⚠️  $manager audit failed or found issues — continuing in non-interactive mode." >&2
        end
    end
    rm -f $audit_out
end

# Applies safe-pnpm's Socket failure semantics. See _safe_pkg_shared.sh for the
# full rationale; the three outcomes are pass, findings (scan ran, unhealthy
# report) and failure (scan could not run). Findings prompt when interactive and
# warn otherwise; failures only warn, because a scan that never ran is not
# evidence of a problem. SAFE_PNPM_SOCKET_STRICT=1 makes both block.
function _safe_pkg_socket_scan
    set -l strict 0
    if test "$SAFE_PNPM_SOCKET_STRICT" = "1"; or test "$SAFE_PNPM_STRICT" = "1"
        set strict 1
    end

    set -l socket_cmd "$HOME/.safe-pnpm/socket"
    set -l classifier "$HOME/.safe-pnpm/socket-classify.js"

    if not test -f $socket_cmd; or not test -f $classifier
        if test $strict -eq 1
            echo "✗ Socket scan requested but not installed — run `safe-pnpm setup` (SAFE_PNPM_SOCKET_STRICT=1)." >&2
            return 1
        end
        echo "⚠️  Socket scan requested but not installed — skipping. Run `safe-pnpm setup`." >&2
        return 0
    end

    echo "→ Socket behavioral scan..." >&2

    set -l out (mktemp)
    # --report waits for the scan to finish and applies the org policy; without
    # it `scan create` can never surface findings.
    $socket_cmd scan create . --report --json --no-spinner --no-banner >$out 2>/dev/null
    set -l rc $status

    set -l reason (node $classifier $out $rc 2>&1)
    set -l verdict $status
    rm -f $out

    if test $verdict -eq 0
        return 0
    end

    if test $strict -eq 1
        echo "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." >&2
        return 1
    end

    if test $verdict -eq 3
        if isatty stdin
            read --prompt-str "⚠️  $reason Continue anyway? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                return 0
            end
            return 1
        end
        echo "⚠️  $reason Continuing in non-interactive mode." >&2
        return 0
    end

    echo "⚠️  $reason Continuing without Socket results." >&2
    return 0
end

# Checks the lockfile the fetch phase resolved against OSV's malicious-package
# advisories. See _safe_pkg_shared.sh for the full rationale: findings always
# block, because a MAL- advisory marks that exact version as malware; failures
# (OSV unreachable, unreadable lockfile, scanner not installed) warn, and
# SAFE_PNPM_OSV_STRICT=1 makes them block too.
function _safe_pkg_malware_scan --argument lockfile
    set -l scanner "$HOME/.safe-pnpm/malware-scan.js"
    set -l reason
    set -l verdict 4

    if test -f $scanner
        echo "→ Malware scan (OSV)..." >&2
        # string collect keeps the multi-line findings list as one value.
        set reason (node $scanner $lockfile 2>&1 | string collect)
        set verdict $pipestatus[1]
    else
        set reason "Malware scan not installed — run `safe-pnpm setup`."
    end

    if test $verdict -eq 0
        printf '✓ %s\n' $reason >&2
        return 0
    end
    if test $verdict -eq 3
        printf '✗ %s\n' $reason >&2
        echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
        return 1
    end
    if test "$SAFE_PNPM_OSV_STRICT" = "1"
        echo "✗ $reason Blocking (SAFE_PNPM_OSV_STRICT=1)." >&2
        return 1
    end
    if test "$SAFE_PNPM_STRICT" = "1"
        echo "✗ $reason Blocking (SAFE_PNPM_STRICT=1)." >&2
        return 1
    end
    echo "⚠️  $reason Continuing without it." >&2
    return 0
end

# Copy-back keeps links inside node_modules as links; every one must stay
# inside the project. See _safe_pkg_copy_modules in _safe_pkg_shared.sh and
# link-check.js. Fails closed: a missing checker refuses copy-back.
function _safe_pkg_links_ok --argument base rel
    set -l checker "$HOME/.safe-pnpm/link-check.js"
    if not test -f $checker
        echo "✗ safe-pnpm: link check not installed — run `safe-pnpm update`; $rel not copied back." >&2
        return 1
    end
    if not node $checker $base $rel
        echo "✗ safe-pnpm: sandbox $rel has links that point outside the project; not copied back." >&2
        return 1
    end
end

# See _safe_pkg_docker_rootless in _safe_pkg_shared.sh. `set -l` keeps the
# status of the command substitution, which is how a failed query is told
# apart from an empty answer.
function _safe_pkg_docker_rootless
    set -l opts (docker info --format '{{json .SecurityOptions}}' 2>/dev/null)
    if test $status -eq 0
        string match -q -- '*"name=rootless"*' "$opts"
        return
    end
    set -l rootless (docker info --format '{{.Host.Security.Rootless}}' 2>/dev/null)
    or return 1
    set rootless (string trim -- "$rootless")
    test "$rootless" = true
end

# Prints the flags that make both containers run as the invoking user, one
# per line. See _safe_pkg_user_flags in _safe_pkg_shared.sh. When the helper
# runs inside a command substitution, as the wrappers call it, fish writes its
# refusal message to the shell's stderr, so a caller's `2>` redirect does not
# capture it; the message still shows on screen.
function _safe_pkg_user_flags
    set -l u (command id -u 2>/dev/null)
    set -l g (command id -g 2>/dev/null)
    if not string match -qr '^[0-9]+$' -- "$u"; or not string match -qr '^[0-9]+$' -- "$g"
        echo "✗ safe-pnpm: could not read your user id (id -u / id -g); refusing to run the install container as root." >&2
        return 1
    end
    if _safe_pkg_docker_rootless
        return 0
    end
    printf '%s\n' --user "$u:$g" -e HOME=/app/.safe-home
end

# Remove only credential-bearing lines from a copied .npmrc/.yarnrc, leaving
# registry URLs, scopes and hoisting config intact. Used between the fetch and
# build phases so build-time lifecycle scripts never see a registry token.
# .yarnrc (v1) writes `_authToken "x"` with no `=`; .yarnrc.yml uses
# npmAuthToken/npmAuthIdent keys with `:`.
function _safe_pkg_strip_npmrc_auth --argument f
    test -f $f; or return 0
    grep -viE '(_authtoken|_auth|_password|username|npmauthtoken|npmauthident)[[:space:]]*[=:"[:space:]]' $f >$f.clean 2>/dev/null
    mv $f.clean $f
end

# The sandbox dirs hold a copy of .npmrc (registry token), so they must go away
# on Ctrl-C or a kill as well as on a normal finish. Wrappers register their
# dirs here; the handler below removes whatever is still registered. fish keeps
# running the wrapper after a signal, but the interrupted docker run returns
# non-zero, which skips the copy-back.
set -g _safe_pkg_sandbox_dirs

# Native optional dependencies (rollup, esbuild, ...) ship one package per
# platform, and the container picks the Linux one. On a macOS host this also
# fetches the host's build, so it is malware-scanned and audited like the rest.
# See _safe_pkg_host_platform in _safe_pkg_shared.sh for the reasoning.
# pnpm: edits the sandbox copy of pnpm-workspace.yaml; prints nothing.
# yarn: prints --ignore-platform. npm: unchanged.
function _safe_pkg_host_platform --argument manager tmpdir
    test (uname -s) = Darwin; or return 0
    set -l cpu
    switch (uname -m)
        case arm64 aarch64
            set cpu arm64
        case x86_64
            set cpu x64
        case '*'
            return 0
    end
    switch $manager
        case pnpm
            set -l ws $tmpdir/pnpm-workspace.yaml
            if test -f $ws; and command grep -q supportedArchitectures $ws
                return 0
            end
            # A file with no trailing newline would glue the key onto its last line.
            if test -s $ws; and test -n (tail -c1 $ws | string collect)
                printf '\n' >>$ws
            end
            printf 'supportedArchitectures:\n  os: [current, darwin]\n  cpu: [current, %s]\n' $cpu >>$ws
        case yarn
            echo --ignore-platform
    end
end

function _safe_pkg_track
    set -g _safe_pkg_sandbox_dirs $_safe_pkg_sandbox_dirs $argv
end

function _safe_pkg_untrack
    for d in $argv
        rm -rf $d
        set -l i (contains -i -- $d $_safe_pkg_sandbox_dirs)
        and set -e _safe_pkg_sandbox_dirs[$i]
    end
end

function _safe_pkg_sandbox_cleanup --on-signal INT --on-signal TERM --on-signal HUP --on-event fish_exit
    for d in $_safe_pkg_sandbox_dirs
        rm -rf $d
    end
    set -g _safe_pkg_sandbox_dirs
end
