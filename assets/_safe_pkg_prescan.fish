# _safe_pkg_prescan.fish — shared prescan for safe-pnpm, safe-npm, safe-yarn (fish shell)
# Place in ~/.config/fish/functions/ — fish autoloads it when _safe_pkg_prescan is first called.

function _safe_pkg_prescan --argument manager lockfile
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

    set -l socket_cmd "$HOME/.safe-pnpm/socket"
    if test -f $socket_cmd
        echo "→ Socket behavioral scan..." >&2
        $socket_cmd scan create . --no-spinner --no-banner >/dev/null 2>&1
        if test $status -ne 0
            if isatty stdin
                read --prompt-str "⚠️  Socket flagged issues. Continue anyway? [y/N] " _ans
                if not string match -qi 'y*' "$_ans"
                    return 1
                end
            else
                echo "⚠️  Socket flagged issues — continuing in non-interactive mode." >&2
            end
        end
    end
end
