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

# _safe_pkg_valueflags manager
#   Prints the global flags that take a separate value, one per line, so the
#   wrappers and the runner finder can skip the value instead of reading it as
#   a command. npx takes npm's list. Same lists as _safe_pkg_valueflags in
#   _safe_pkg_shared.sh.
function _safe_pkg_valueflags --argument manager
    switch $manager
        case pnpm
            printf '%s\n' -C --dir -F --filter --filter-prod --workspace-dir --reporter --loglevel --config --store-dir --state-dir --registry --lockfile-dir --network-concurrency --fetch-timeout --workspace-concurrency --test-pattern --changed-files-ignore-pattern --http-proxy --https-proxy --no-proxy --user-agent
        case npm npx
            printf '%s\n' --prefix -w --workspace --registry --cache --userconfig --globalconfig --loglevel --otp --scope --omit --include --install-strategy --tag --before --audit-level --fetch-retries --lockfile-version --min-release-age --cpu --os --libc --script-shell --node-options --maxsockets --location
        case yarn
            printf '%s\n' --cwd --registry --modules-folder --cache-folder --preferred-cache-folder --global-folder --link-folder --network-concurrency --network-timeout --proxy --https-proxy --mutex --use-yarnrc --cafile --otp
    end
end

# _safe_pkg_runner_specs manager args...
#   For the commands that download a package and run it (npx, pnpx, npm exec,
#   npm init|create, pnpm dlx|create, yarn dlx|create) prints the package specs
#   that will be fetched, one per line, and returns 0. Returns 1 for any other
#   command. See _safe_pkg_runner_specs in _safe_pkg_shared.sh for the rules
#   (every reading of an ambiguous parse is scanned, -p/--package, npm's
#   abbreviations, the create- prefix).
function _safe_pkg_runner_specs
    set -l manager $argv[1]
    set -e argv[1]
    switch $manager
        case npx
            _safe_pkg_runner_tail npm exec 0 -- $argv
            return 0
        case pnpx
            _safe_pkg_runner_tail pnpm exec 0 -- $argv
            return 0
    end
    set -l value_flags (_safe_pkg_valueflags $manager)
    # skip: 0, 1 (drop the next word) or pkg (the next word is a package).
    set -l skip 0
    set -l maybe 0
    set -l dd 0
    set -l found 1
    set -l pkgs
    while set -q argv[1]
        set -l a $argv[1]
        set -e argv[1]
        if test $dd -eq 0
            if test "$skip" != 0
                if string match -q -- '-*' $a
                    set skip 0
                    set maybe 1
                    continue
                end
                test "$skip" = pkg; and set -a pkgs $a
                set skip 0
                continue
            end
            switch $a
                case --
                    test "$manager" = yarn; and break
                    set dd 1
                    set maybe 0
                    continue
                case '--package=*'
                    set maybe 0
                    test "$manager" = yarn; or set -a pkgs (string replace -r '^[^=]*=' '' -- $a)
                    continue
                case --package
                    set maybe 0
                    if test "$manager" = yarn
                        set maybe 1
                    else
                        set skip pkg
                    end
                    continue
                case '-*=*'
                    set maybe 0
                    continue
                case '-*'
                    set maybe 1
                    if contains -- $a $value_flags; or _safe_pkg_dir_flag $manager $a >/dev/null
                        set maybe 0
                        set skip 1
                    end
                    continue
            end
        end
        set -l n (string lower -- $a)
        set -l mode
        switch "$manager:$n"
            case npm:exec npm:exe npm:x pnpm:dlx yarn:dlx
                set mode exec
            case npm:init npm:ini npm:inn npm:inni npm:innit npm:cr npm:cre npm:crea npm:creat npm:create pnpm:create yarn:create
                set mode create
        end
        if test -n "$mode"
            set found 0
            _safe_pkg_runner_tail $manager $mode $dd $pkgs -- $argv
        end
        # A word that may be a flag's value: the next word may be the command.
        if test $maybe -eq 1; and test $dd -eq 0
            set maybe 0
            continue
        end
        break
    end
    return $found
end

# _safe_pkg_runner_tail manager mode dashdash [pkgs...] -- [args after the command word...]
#   The spec finder for one reading of the command word; see
#   _safe_pkg_runner_specs. pkgs are the --package values read before the
#   command word; dashdash 1 means a -- came before it, so no word is a flag.
function _safe_pkg_runner_tail
    set -l manager $argv[1]
    set -l mode $argv[2]
    set -l dd $argv[3]
    set -e argv[1..3]
    set -l pkgs
    while set -q argv[1]
        set -l a $argv[1]
        set -e argv[1]
        test "$a" = --; and break
        set -a pkgs $a
    end
    set -l value_flags (_safe_pkg_valueflags $manager)
    set -l skip 0
    set -l maybe 0
    set -l found 0
    set -l pos
    for a in $argv
        if test $dd -eq 0
            if test "$skip" != 0
                if string match -q -- '-*' $a
                    set skip 0
                    set maybe 1
                    continue
                end
                test "$skip" = pkg; and set -a pkgs $a
                set skip 0
                continue
            end
            switch "$manager:$a"
                case '*:--'
                    set dd 1
                    test $found -eq 1; and break
                    set maybe 0
                    continue
                case npm:-p npm:--package pnpm:-p pnpm:--package
                    set maybe 0
                    set skip pkg
                    continue
                case 'npm:--package=*' 'npm:-p=*' 'pnpm:--package=*' 'pnpm:-p=*'
                    set maybe 0
                    set -a pkgs (string replace -r '^[^=]*=' '' -- $a)
                    continue
                case npm:-c npm:--call
                    set maybe 0
                    set skip 1
                    continue
                case '*:-*=*' pnpm:-c '*:-y' '*:--yes' '*:-n' '*:--no' '*:--no-install' '*:--ignore-existing' '*:-s' '*:--shell-mode' '*:--silent' '*:-q' '*:--quiet' '*:--verbose' '*:--json' '*:--offline' '*:--prefer-offline' '*:-ws' '*:--workspaces' '*:--no-workspaces' '*:--include-workspace-root' '*:--no-color' '*:--color' '*:--no-fund' '*:--no-audit'
                    set maybe 0
                    continue
                case '*:-*'
                    set maybe 1
                    if contains -- $a $value_flags
                        set maybe 0
                        set skip 1
                    end
                    continue
            end
        end
        # npm reads flags after the command name too; only --package matters there.
        test $found -eq 1; and continue
        set -a pos $a
        if test $maybe -eq 1; and test $dd -eq 0
            set maybe 0
            continue
        end
        set found 1
        test "$manager" = npm; and test $dd -eq 0; and continue
        break
    end

    if test "$mode" = create
        set -q pkgs[1]; and printf '%s\n' $pkgs
        for line in $pos
            test -z "$line"; and continue
            set -l scope ""
            set -l rest $line
            if string match -q -- '@*/*' $line
                set scope (string replace -r '/.*' '' -- $line)/
                set rest (string replace -r '^[^/]*/' '' -- $line)
            else if string match -q -- '@*' $line
                # `create @scope[@version]` runs @scope/create
                set rest (string sub -s 2 -- $line)
                set -l name (string replace -r '@.*' '' -- $rest)
                set -l ver (string replace -r '^[^@]*' '' -- $rest)
                printf '%s\n' "@$name/create$ver"
                continue
            end
            printf '%s\n' "$scope"create-"$rest"
            string match -q -- 'create-*' $rest; and printf '%s\n' $line
        end
        return 0
    end
    if set -q pkgs[1]
        printf '%s\n' $pkgs
    else if set -q pos[1]
        printf '%s\n' $pos
    end
    return 0
end

# _safe_pkg_runner_check manager args...
#   Runs before a download-and-run command. Not one of them: succeeds at once.
#   Otherwise checks the packages it would fetch against OSV (malware-scan.js
#   --specs) and fails, so the caller does not run the command, when one has a
#   MAL- advisory. A scan that cannot run warns, or blocks under
#   SAFE_PNPM_OSV_STRICT=1 / SAFE_PNPM_STRICT=1, like the install path.
#   `set` keeps the status of its command substitution, which tells "not a
#   runner command" apart from a runner with no package spec.
function _safe_pkg_runner_check
    set -l specs (_safe_pkg_runner_specs $argv)
    or return 0
    set -l args
    for spec in $specs
        test -n "$spec"; and set -a args $spec
    end
    set -q args[1]; or return 0
    _safe_pkg_malware_scan --specs $args
end

# _safe_pkg_malware_scan lockfile
# _safe_pkg_malware_scan --specs spec...
#   Checks the lockfile the fetch phase resolved, or the packages a
#   download-and-run command would fetch, against OSV's malicious-package
#   advisories. See _safe_pkg_shared.sh for the full rationale: findings always
#   block, because a MAL- advisory marks that exact version as malware; failures
#   (OSV unreachable, unreadable lockfile, failed version lookup, scanner not
#   installed) warn, and SAFE_PNPM_OSV_STRICT=1 makes them block too.
function _safe_pkg_malware_scan
    set -l scanner "$HOME/.safe-pnpm/malware-scan.js"
    set -l reason
    set -l verdict 4

    if test -f $scanner
        echo "→ Malware scan (OSV)..." >&2
        # string collect keeps the multi-line findings list as one value.
        set reason (node $scanner $argv 2>&1 | string collect)
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
        if test "$argv[1]" = --specs
            echo "✗ safe-pnpm: not running it; no package code was executed." >&2
        else
            echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
        end
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
# pnpm: pnpm-arch.js edits the sandbox copy of pnpm-workspace.yaml, or of
# package.json for a project pinned to pnpm 10 or earlier (saving the original to
# $saved for _safe_pkg_pnpm_arch_restore); prints nothing.
# yarn: prints --ignore-platform. npm: unchanged.
function _safe_pkg_host_platform --argument manager tmpdir saved
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
            set -l helper "$HOME/.safe-pnpm/pnpm-arch.js"
            if not test -f $helper
                echo "⚠️  safe-pnpm: pnpm-arch.js missing, so native packages for darwin are not fetched (run: safe-pnpm update)." >&2
            else if not node $helper apply $tmpdir darwin $cpu $saved >&2
                echo "⚠️  safe-pnpm: could not add darwin to pnpm's supportedArchitectures, so native packages for darwin are not fetched." >&2
            end
        case yarn
            echo --ignore-platform
    end
end

# See _safe_pkg_pnpm_arch_restore in _safe_pkg_shared.sh. Returns 1 when the
# snapshot must not be copied back.
function _safe_pkg_pnpm_arch_restore --argument file saved
    test -f $saved; or return 0
    if not node "$HOME/.safe-pnpm/pnpm-arch.js" restore $file $saved
        echo "✗ safe-pnpm: could not take safe-pnpm's supportedArchitectures out of package.json; nothing copied back." >&2
        return 1
    end
end

# Prints the macOS host's OS and CPU in npm's names (two lines), nothing otherwise.
function _safe_pkg_host_os_cpu
    test (uname -s) = Darwin; or return 0
    switch (uname -m)
        case arm64 aarch64
            echo darwin
            echo arm64
        case x86_64
            echo darwin
            echo x64
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

# _safe_pkg_is_global args...
#   True when the args ask for a global install. See _safe_pkg_is_global in
#   _safe_pkg_shared.sh for why the wrapper refuses these.
function _safe_pkg_is_global
    # yarn v1 spells it as a subcommand: yarn global add|remove|upgrade
    set -l words
    for a in $argv
        string match -q -- '-*' $a; or set words $words $a
    end
    if test "$words[1]" = global; and contains -- "$words[2]" add remove upgrade
        return 0
    end
    set -l loc ""
    for a in $argv
        if test -n "$loc" -a "$a" = global
            return 0
        end
        set loc ""
        test "$a" = --; and return 1
        string match -q -- '-*' $a; or continue
        set -l name (string replace -r -- '^-+' '' $a)
        set -l key (string split -m 1 -- = $name)[1]
        set -l val ""
        string match -q -- '*=*' $name; and set val (string split -m 1 -- = $name)[2]
        test -n "$key"; or continue
        if string match -q -- '--*' $a
            if string match -q -- "$key*" global; and test "$val" != false
                return 0
            end
            if test (string length -- $key) -ge 3; and string match -q -- "$key*" location
                if string match -q -- '*=*' $name
                    test "$val" = global; and return 0
                else
                    set loc 1
                end
            end
        else if string match -q -- '*g*' $key
            if test "$key" != g -o "$val" != false
                return 0
            end
        end
    end
    return 1
end

# _safe_pkg_dir_flag manager args...
#   Prints the first flag that points the package manager at another directory
#   and succeeds; fails when there is none. See _safe_pkg_dir_flag in
#   _safe_pkg_shared.sh for why the wrapper refuses these and which spellings
#   each manager accepts.
function _safe_pkg_dir_flag --argument manager
    for a in $argv[2..-1]
        test "$a" = --; and return 1
        string match -q -- '-*' $a; or continue
        set -l name (string replace -r '=.*' '' -- $a)
        if test "$manager" = yarn
            test "$name" = --cwd; or continue
        else
            set name (string replace -r '^-+' '' -- $name)
            switch "$manager:$name"
                case npm:prefi npm:prefix pnpm:dir pnpm:prefi pnpm:prefix pnpm:shrinkwrap-directory
                case pnpm:lockfile-d pnpm:lockfile-di pnpm:lockfile-dir pnpm:lockfile-dire pnpm:lockfile-direc pnpm:lockfile-direct pnpm:lockfile-directo pnpm:lockfile-director pnpm:lockfile-directory
                case 'pnpm:config.*'
                    set -l key (string replace -r '^config\.' '' -- $name | string lower | string replace -a -r '[-_]' '')
                    contains -- "$key" dir prefix lockfiledir; or continue
                case '*'
                    string match -qr -- '^[A-Za-z]*C[A-Za-z]*$' $name; or continue
            end
        end
        printf '%s\n' $a
        return 0
    end
    return 1
end

# _safe_pkg_lockfile_dir_setting dir
#   Prints the file and key of the first setting in dir's .npmrc or
#   pnpm-workspace.yaml that moves pnpm's lockfile, and succeeds; fails when
#   there is none. See _safe_pkg_lockfile_dir_setting in _safe_pkg_shared.sh.
function _safe_pkg_lockfile_dir_setting --argument dir
    if test -f "$dir/.npmrc"
        set -l m (string match -ri -- '^\s*["\']?(lockfile-dir|lockfile-directory|shrinkwrap-directory)["\']?\s*=' <"$dir/.npmrc")
        if set -q m[2]
            printf '%s\n' .npmrc $m[2]
            return 0
        end
    end
    if test -f "$dir/pnpm-workspace.yaml"
        set -l m (string match -ri -- '^[^#]*(lockfile-?dir)["\']?\s*:' <"$dir/pnpm-workspace.yaml")
        if set -q m[2]
            printf '%s\n' pnpm-workspace.yaml $m[2]
            return 0
        end
    end
    return 1
end

# _safe_pkg_unshared_lockfile_setting dir root args...
#   Prints what turns off pnpm's shared workspace lockfile and succeeds; fails
#   when nothing does. See _safe_pkg_unshared_lockfile_setting in
#   _safe_pkg_shared.sh.
function _safe_pkg_unshared_lockfile_setting --argument dir root
    set -l key_re 'shared-?workspace-?(lockfile|shrinkwrap)'
    if test -f "$dir/.npmrc"
        set -l m (string match -ri -- '^\s*["\']?('$key_re')["\']?\s*=\s*["\']?false(?:[^[:alnum:]]|$)' <"$dir/.npmrc")
        if set -q m[2]
            echo "$root/.npmrc sets $m[2] to false"
            return 0
        end
    end
    if test -f "$dir/pnpm-workspace.yaml"
        set -l m (string match -ri -- '^[^#]*?('$key_re')["\']?\s*:\s*["\']?false(?:[^[:alnum:]]|$)' <"$dir/pnpm-workspace.yaml")
        if set -q m[2]
            echo "$root/pnpm-workspace.yaml sets $m[2] to false"
            return 0
        end
    end
    set -l prev
    for a in $argv[3..-1]
        if test -n "$prev"
            if string match -qi -- false $a
                echo "$prev $a sets shared-workspace-lockfile to false"
                return 0
            end
            set prev
        end
        test "$a" = --; and return 1
        string match -q -- '-*' $a; or continue
        set -l name (string lower -- (string replace -r -- '^-+' '' (string split -m1 -- = $a)[1]))
        set -l key (string replace -a -r -- '[-_]' '' (string replace -r -- '^config\.' '' $name))
        set -l neg 0
        if string match -q -- 'no*' $key
            set neg 1
            set key (string sub -s 3 -- $key)
        end
        string match -qr -- '^shared[a-z]*$' $key; or continue
        if not string match -q -- "$key*" sharedworkspacelockfile; and not string match -q -- "$key*" sharedworkspaceshrinkwrap
            continue
        end
        if string match -q -- '*=*' $a
            set -l val (string lower -- (string split -m1 -- = $a)[2])
            test $neg = 1 -a "$val" = false; and continue
            test $neg = 0 -a "$val" != false; and continue
            echo "$a sets shared-workspace-lockfile to false"
            return 0
        end
        if test $neg = 1
            echo "$a sets shared-workspace-lockfile to false"
            return 0
        end
        set prev $a
    end
    return 1
end
