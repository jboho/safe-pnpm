# _safe_pkg_prescan.fish — shared prescan for safe-pnpm, safe-npm, safe-yarn (fish shell)
# Place in ~/.config/fish/functions/ — fish autoloads it when _safe_pkg_prescan is first called.

function _safe_pkg_prescan --argument manager lockfile socket_flag
    if test -f $lockfile
        echo "→ $manager audit..." >&2
        switch $manager
            case pnpm
                command pnpm audit --audit-level moderate >/dev/null 2>&1
            case npm
                command npm audit --audit-level moderate >/dev/null 2>&1
            case yarn
                command yarn audit >/dev/null 2>&1
        end
        if test $status -ne 0
            if isatty stdin
                read --prompt-str "⚠️  $manager audit found issues. Continue anyway? [y/N] " _ans
                if not string match -qi 'y*' "$_ans"
                    return 1
                end
            else
                echo "⚠️  $manager audit found issues — continuing in non-interactive mode." >&2
            end
        end
    end

    set -l sha "$HOME/.safe-pnpm/scan-shai-hulud.js"
    if test -f $sha
        echo "→ Supply chain scan (Shai Hulud 2)..." >&2
        node $sha (pwd) >/dev/null 2>&1
        if test $status -ne 0
            if isatty stdin
                read --prompt-str "⚠️  Supply chain scan flagged issues. Continue anyway? [y/N] " _ans
                if not string match -qi 'y*' "$_ans"
                    return 1
                end
            else
                echo "⚠️  Supply chain scan flagged issues — continuing in non-interactive mode." >&2
            end
        end
    end

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

# Applies safe-pnpm's Socket failure semantics. See _safe_pkg_shared.sh for the
# full rationale; the three outcomes are pass, findings (scan ran, unhealthy
# report) and failure (scan could not run). Findings prompt when interactive and
# warn otherwise; failures only warn, because a scan that never ran is not
# evidence of a problem. SAFE_PNPM_SOCKET_STRICT=1 makes both block.
function _safe_pkg_socket_scan
    set -l strict 0
    if test "$SAFE_PNPM_SOCKET_STRICT" = "1"
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
