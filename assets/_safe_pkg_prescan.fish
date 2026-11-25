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
# project's .pnpmfile.cjs, which would otherwise run on the host. With a
# command after tmpdir (the Yarn 2+ audit container), runs that instead.
function _safe_pkg_audit --argument manager lockfile snapdir tmpdir
    test -f "$snapdir/$lockfile"; or return 0

    set -l audit_out (mktemp)
    or return 1
    set -l audit_rc 0
    if set -q argv[5]
        echo "→ $manager audit..." >&2
        $argv[5..-1] >$audit_out 2>&1
        set audit_rc $status
    else
        set -l auditdir (mktemp -d)
        or begin
            rm -f $audit_out
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
        set audit_rc $status
        popd >/dev/null
        rm -rf $auditdir
    end

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
    # The tag tells malware-scan.js to refuse a spec that names no version.
    set -l tag exec-dlx:
    test "$manager" = npm; and set tag exec-npm:
    set -q pkgs[1]; or set pkgs $pos
    for line in $pkgs
        test -n "$line"; and printf '%s%s\n' $tag $line
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

# Copies the user's own .npmrc auth lines whose value is exactly
# ${NODE_AUTH_TOKEN} or ${NPM_TOKEN} into the sandbox and prints the docker
# flags that make that copy the container's user config. See
# _safe_pkg_user_auth in _safe_pkg_shared.sh.
function _safe_pkg_user_auth --argument tmpdir
    set -l src "$HOME/.npmrc"
    test -n "$npm_config_userconfig"; and set src "$npm_config_userconfig"
    test -n "$NPM_CONFIG_USERCONFIG"; and set src "$NPM_CONFIG_USERCONFIG"
    set -l vars
    test -n "$NODE_AUTH_TOKEN"; and set vars $vars NODE_AUTH_TOKEN
    test -n "$NPM_TOKEN"; and set vars $vars NPM_TOKEN
    test (count $vars) -gt 0; and test -f "$src"; or return 0
    mkdir -p $tmpdir/.safe-home
    grep -E '^[[:space:]]*//[^[:space:]=]+:_auth(Token)?[[:space:]]*=[[:space:]]*\$\{('(string join '|' $vars)')\}[[:space:]]*$' "$src" >$tmpdir/.safe-home/.npmrc 2>/dev/null
    if test -s $tmpdir/.safe-home/.npmrc
        printf '%s\n' -e NPM_CONFIG_USERCONFIG=/app/.safe-home/.npmrc
    else
        rm -f $tmpdir/.safe-home/.npmrc
    end
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

# _safe_pkg_yarn_berry dir
#   Prints what marks dir as a Yarn 2+ (Berry) project and succeeds; fails
#   when nothing does. See _safe_pkg_yarn_berry in _safe_pkg_shared.sh.
function _safe_pkg_yarn_berry --argument dir
    if test -f "$dir/yarn.lock"; and string match -qr -- '^__metadata:' <"$dir/yarn.lock"
        echo "$dir/yarn.lock is a Yarn 2+ lockfile"
        return 0
    end
    if test -f "$dir/.yarnrc.yml"
        echo "$dir/.yarnrc.yml is a Yarn 2+ settings file"
        return 0
    end
    if test -f "$dir/package.json"
        set -l m (string match -r -- '"packageManager"\s*:\s*"(yarn@[0-9][0-9.]*)' <"$dir/package.json")
        # The major as text, as the bash wrapper reads it: no leading zero,
        # and no number that `test` would overflow on.
        if set -q m[2]; and string match -qr -- '^yarn@([2-9]|[1-9][0-9])' $m[2]
            echo "$dir/package.json sets packageManager to "(string trim -r -c . -- $m[2])
            return 0
        end
    end
    return 1
end

# _safe_pkg_yarn_berry_root
#   Prints the root of the Yarn 2+ project the current directory belongs to
#   and succeeds; fails for a Yarn 1 project or none. The root is the nearest
#   directory with a yarn.lock, walking up and stopping below HOME and /, or
#   else the current directory. See _safe_pkg_yarn_berry_root in
#   _safe_pkg_shared.sh.
function _safe_pkg_yarn_berry_root
    set -l root $PWD
    set -l d $PWD
    while test "$d" != "$HOME"; and test "$d" != /
        if test -f "$d/yarn.lock"
            set root $d
            break
        end
        # string replace, not `path dirname`, which fish before 3.5 lacks;
        # and stop if d stops changing, so a failed step cannot loop forever.
        set -l up (string replace -r -- '/[^/]*\z' '' "$d" | string collect)
        test -n "$up"; or set up /
        test "$up" = "$d"; and break
        set d $up
    end
    if _safe_pkg_yarn_berry $root >/dev/null; or _safe_pkg_yarn_berry $PWD >/dev/null
        printf '%s\n' $root
        return 0
    end
    return 1
end

# _safe_pkg_yarnrc_set file key
#   Succeeds when the .yarnrc.yml file sets the top-level key. Only reliable
#   on a file _safe_pkg_yarnrc_plain accepted.
function _safe_pkg_yarnrc_set --argument file key
    test -f "$file"; and command grep -qE "^[\"']?"$key"[\"']?[[:space:]]*:" "$file"
end

# The awk programs and the node script below are the ones in
# _safe_pkg_shared.sh, byte for byte apart from fish's quoting (every
# backslash doubled), so both shells read the files the same way. BWK awk
# (macOS) ends a line at a NUL byte, hence the byte count before each awk.

# _safe_pkg_yarnrc_plain file
#   Prints the first line of the .yarnrc.yml file that does not keep every
#   top-level key at the start of a line as a plain name, and succeeds; fails
#   when the file is missing or plain. See _safe_pkg_shared.sh.
function _safe_pkg_yarnrc_plain --argument file
    test -f "$file"; or return 1
    if test (LC_ALL=C tr -d '\000' <"$file" | wc -c) -ne (wc -c <"$file")
        echo 1
        return 0
    end
    set -l n (LC_ALL=C awk '
    { sub(/\\r$/, "") }
    /[^\\t -~]/ { print NR; exit }
    /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
    /^ / { if (started) next; print NR; exit }
    /^[A-Za-z][A-Za-z0-9]*[[:space:]]*:/ { started = 1; next }
    { print NR; exit }
    ' "$file")
    if test -n "$n"
        printf '%s\n' $n
        return 0
    end
    return 1
end

# _safe_pkg_yarnrc_interp file
#   Prints the first line of the .yarnrc.yml file that holds ${ or a
#   backslash outside an npmAuthToken or npmAuthIdent setting, and succeeds;
#   fails when there is none. See _safe_pkg_shared.sh.
function _safe_pkg_yarnrc_interp --argument file
    test -f "$file"; or return 1
    set -l n (LC_ALL=C awk '
    /\\$\\{|\\\\/ && !/^[[:space:]]*(npmAuthToken|npmAuthIdent)[[:space:]]*:/ { print NR; exit }
    ' "$file")
    if test -n "$n"
        printf '%s\n' $n
        return 0
    end
    return 1
end

# _safe_pkg_yarn_net_check root
#   Prints why the registry, proxy and TLS settings of root/.yarnrc.yml are
#   refused, and succeeds; fails when they pass: each must already be in
#   ~/.yarnrc.yml with the same value. See _safe_pkg_shared.sh.
function _safe_pkg_yarn_net_check --argument root
    set -l proj "$root/.yarnrc.yml"
    set -l home "$HOME/.yarnrc.yml"
    test -f "$proj"; or return 1
    test -f "$home"; or set home /dev/null
    test "$proj" -ef "$home"; and return 1
    set -l out (LC_ALL=C awk '
    BEGIN {
      sq = sprintf("%c", 39)
      keyre = "^[A-Za-z][A-Za-z0-9]*[ \\t]*:"
      scopere = "^(\\"[^\\"\\\\\\\\]*\\"|" sq "[^" sq "]*" sq "|[A-Za-z0-9][A-Za-z0-9._-]*)[ \\t]*:"
      net = "^(npmRegistryServer|npmAuditRegistry|httpProxy|httpsProxy|enableStrictSsl|caFilePath|httpsCaFilePath|httpsCertFilePath|httpsKeyFilePath)$"
    }
    function bad(n) { print "U " (ishome ? "H" : "P") " " n; done = 1; exit }
    function empty(s) { sub(/^[ \\t]+/, "", s); return s == "" || s ~ /^#/ }
    function val(s, n,   q, k, v, rest) {
      sub(/^[ \\t]+/, "", s)
      if (empty(s)) bad(n)
      q = substr(s, 1, 1)
      if (q == "\\"" || q == sq) {
        rest = substr(s, 2); k = index(rest, q)
        if (k == 0) bad(n)
        v = substr(rest, 1, k - 1); rest = substr(rest, k + 1)
        if (rest !~ /^([ \\t]+#.*)?[ \\t]*$/ || (q == "\\"" && index(v, "\\\\"))) bad(n)
      } else {
        if (index("-?:,[]{}#&*!|>%@`", q)) bad(n)
        v = s; sub(/[ \\t]#.*/, "", v); sub(/[ \\t]+$/, "", v)
        if (v ~ /: / || v ~ /:$/) bad(n)
      }
      if (v ~ /[^!-~]/) bad(n)
      return v
    }
    function norm(v,   s, a, r) {
      if (match(v, /^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//)) {
        s = substr(v, 1, RLENGTH); a = substr(v, RLENGTH + 1); r = ""
        if (match(a, /[\\/\\\\?#]/)) { r = substr(a, RSTART); a = substr(a, 1, RSTART - 1) }
        sub(/.*@/, "", a)
        v = tolower(s a) r
      }
      sub(/\\/+$/, "", v)
      return v
    }
    function rec(p, v, n) {
      v = norm(v)
      if (ishome) H[p SUBSEP v] = 1
      else { np++; P[np] = p; PV[np] = v; PL[np] = n }
    }
    FILENAME != cur { cur = FILENAME; ishome = (FILENAME == ARGV[1]); blk = 0; chk = -1 }
    { sub(/\\r$/, "") }
    /^[ \\t]*$/ { next }
    {
      match($0, /^[ \\t]*/); ind = RLENGTH; line = substr($0, ind + 1)
      if (chk >= 0) { if (ind > chk) bad(chkn); chk = -1 }
    }
    /^[ \\t]*#/ { next }
    ind == 0 {
      blk = 0
      if (!match(line, keyre)) next
      key = substr(line, 1, RLENGTH); sub(/[ \\t]*:$/, "", key); rest = substr(line, RLENGTH + 1)
      if (key == "npmScopes") {
        if (!empty(rest)) bad(FNR)
        blk = 1; i1 = 0; scope = ""
      } else if (key ~ net) { rec(key, val(rest, FNR), FNR); chk = 0; chkn = FNR }
      next
    }
    !blk { next }
    substr($0, 1, ind) ~ /\\t/ { bad(FNR) }
    {
      if (!i1) i1 = ind
      if (ind == i1) {
        if (!match(line, scopere)) bad(FNR)
        scope = substr(line, 1, RLENGTH); sub(/[ \\t]*:$/, "", scope)
        gsub("^[\\"" sq "]|[\\"" sq "]$", "", scope)
        if (scope == "" || scope ~ /[^!-~]/ || !empty(substr(line, RLENGTH + 1))) bad(FNR)
        i2 = 0; inval = 0
        next
      }
      if (ind < i1 || scope == "") bad(FNR)
      if (!i2) i2 = ind
      if (ind > i2) { if (inval) next; bad(FNR) }
      if (ind < i2 || !match(line, keyre)) bad(FNR)
      key = substr(line, 1, RLENGTH); sub(/[ \\t]*:$/, "", key)
      inval = key != "npmRegistryServer"
      if (!inval) { rec("npmScopes." scope "." key, val(substr(line, RLENGTH + 1), FNR), FNR); chk = i2; chkn = FNR }
    }
    END {
      if (done) exit
      for (i = 1; i <= np; i++) {
        p = P[i]; v = PV[i]
        if ((p == "npmRegistryServer" || p ~ /^npmScopes\\..*\\.npmRegistryServer$/) && (v == "https://registry.yarnpkg.com" || v == "https://registry.npmjs.org")) continue
        if (p == "enableStrictSsl" && v == "true") continue
        if ((p SUBSEP v) in H) continue
        print "D " p " " v " " PL[i]
        exit
      }
    }
    ' "$home" "$proj")
    or set out "U P 1"
    test -n "$out"; or return 1
    if string match -q -- 'U *' "$out"
        set -l f "$proj"
        string match -q -- 'U H *' "$out"; and set f "$HOME/.yarnrc.yml"
        set -l n (string replace -r '.* ' '' -- "$out")
        echo "$f has a registry or proxy setting the wrapper cannot read safely (line $n): write it as key: value on one line, with a plain or quoted value and no anchors, aliases, tags, braces or multi-line text, and run the command again."
    else
        set -l rest (string replace -r '^D ' '' -- "$out")
        set -l k (string replace -r ' .*' '' -- "$rest")
        set rest (string replace -r '^[^ ]* ' '' -- "$rest")
        set -l v (string replace -r ' [^ ]*$' '' -- "$rest")
        set -l n (string replace -r '.* ' '' -- "$rest")
        echo "$proj sets $k to $v, which is not the value in $HOME/.yarnrc.yml. The fetch phase has the registry token, and Yarn could send it to a registry or proxy the project picked. If you trust that server, add the same setting (line $n) to $HOME/.yarnrc.yml and run the command again."
    end
    return 0
end

# _safe_pkg_yarn_manifest_check root
#   Prints why a package.json the sandbox copies is refused (an exec:
#   dependency, dependenciesMeta built, not JSON), and succeeds; fails when
#   none is. Fails closed without node. See _safe_pkg_shared.sh.
function _safe_pkg_yarn_manifest_check --argument root
    set -l nonode "package.json: the wrapper could not check the package.json files with node, so it does not run the command."
    if not pushd "$root" 2>/dev/null
        echo "$root/$nonode"
        return 0
    end
    set -l out (begin
            printf './package.json\0'
            find . -mindepth 2 -name package.json -not -path "*/node_modules/*" -not -path "./.yarn/*" \
                -not -path "./.corepack/*" -not -path "./.safe-home/*" -not -path "./.safe-store/*" -print0
        end | node -e '
    const fs = require("fs");
    const safe = (s) => String(s).replace(/[^ -~]/g, "?");
    const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"];
    for (const f of fs.readFileSync(0, "utf8").split("\\0").filter(Boolean)) {
      const p = safe(f.slice(2));
      let m;
      try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { m = undefined; }
      if (!m || typeof m !== "object") {
        console.log(`${p} is not valid JSON, so the wrapper cannot check its dependencies. Fix the file and run the command again.`);
        process.exit(1);
      }
      for (const k of fields) {
        for (const [n, v] of Object.entries(m[k] ?? {})) {
          if (/exec(:|%3a)/i.test(String(v))) {
            console.log(`${p} depends on ${safe(n)} through exec:, which the wrapper does not support: Yarn runs its script while it fetches, when the registry token is still available.`);
            process.exit(1);
          }
        }
      }
      for (const [n, v] of Object.entries(m.dependenciesMeta ?? {})) {
        if (v && typeof v === "object" && "built" in v && v.built !== false) {
          console.log(`${p} sets dependenciesMeta.${safe(n)}.built, which the wrapper does not support: it lets Yarn run an exec: dependency script while it fetches, when the registry token is still available. Remove the setting and run the command again.`);
          process.exit(1);
        }
      }
    }
    ' 2>/dev/null)
    set -l st $status
    popd
    test $st -eq 0; and return 1
    test -n "$out"; or set out $nonode
    echo "$root/$out"
    return 0
end

# _safe_pkg_yarn_berry_pin root
#   Prints the packageManager value of root/package.json and succeeds when it
#   pins an exact Yarn 3+ release (optionally with corepack's +hash).
function _safe_pkg_yarn_berry_pin --argument root
    set -l pm (command grep -oE '"packageManager"[[:space:]]*:[[:space:]]*"[^"]*"' "$root/package.json" 2>/dev/null | head -n 1 | sed -E 's/.*:[[:space:]]*"//; s/"$//')
    printf '%s\n' "$pm"
    printf '%s\n' "$pm" | command grep -qE '^yarn@([3-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.]+)?$'
end

# _safe_pkg_yarn_origins
#   Prints the registry origins the user trusts, each between spaces: the
#   public npm registries and every npmRegistryServer in ~/.yarnrc.yml.
function _safe_pkg_yarn_origins
    set -l f "$HOME/.yarnrc.yml"
    test -r "$f"; or set f /dev/null
    LC_ALL=C awk -v sq="'" '
    BEGIN { o = " https://registry.npmjs.org https://registry.yarnpkg.com " }
    { sub(/\\r$/, "") }
    match($0, "^[ \\t]*[\\"" sq "]?npmRegistryServer[\\"" sq "]?[ \\t]*:[ \\t]*") {
      v = substr($0, RLENGTH + 1); sub(/[ \\t]+#.*/, "", v); sub(/[ \\t]+$/, "", v)
      gsub("^[\\"" sq "]|[\\"" sq "]$", "", v)
      v = tolower(v)
      if (!match(v, /^https?:\\/\\/[^\\/?#\\\\]*/)) next
      a = substr(v, 1, RLENGTH); s = substr(a, 1, index(a, "//") + 1); a = substr(a, length(s) + 1)
      sub(/.*@/, "", a)
      if (a ~ /^[a-z0-9.-]+(:[0-9]+)?$/) o = o s a " "
    }
    END { print o }
    ' "$f"
end

# _safe_pkg_yarn_lock_check file
#   Prints "G N" for a line of the yarn.lock not in the layout Yarn writes,
#   "S RESOLUTION" for an unsupported source, or "A RESOLUTION" for a download
#   from a server outside _safe_pkg_yarn_origins, and succeeds; fails when
#   the lockfile passes or is missing. See _safe_pkg_shared.sh.
function _safe_pkg_yarn_lock_check --argument f
    test -f "$f"; or return 1
    if test (LC_ALL=C tr -d '\000' <"$f" | wc -c) -ne (wc -c <"$f")
        echo "G 1"
        return 0
    end
    set -l origins (_safe_pkg_yarn_origins)
    set -l out (LC_ALL=C awk -v origins="$origins" '
    function fail(k, v) { print k " " v; done = 1; exit }
    function dec(u,   out, i, c) {
      out = ""
      while ((i = index(u, "%")) > 0) {
        c = tolower(substr(u, i + 1, 2))
        if (c !~ /^[0-9a-f][0-9a-f]$/) return ""
        c = (index(hx, substr(c, 1, 1)) - 1) * 16 + index(hx, substr(c, 2, 1)) - 1
        if (c < 33 || c > 126) return ""
        out = out substr(u, 1, i - 1) sprintf("%c", c)
        u = substr(u, i + 3)
      }
      return out u
    }
    function trusted(u,   a, s) {
      if (u ~ /[^!-~]/) return 0
      u = tolower(u)
      if (!match(u, /^https?:\\/\\/[a-z0-9.-]+(:[0-9]+)?/)) return 0
      a = substr(u, 1, RLENGTH); s = substr(u, RLENGTH + 1)
      if (s != "" && s !~ /^\\//) return 0
      return index(origins, " " a " ") > 0
    }
    function archok(r,   i) {
      if ((i = index(r, "::__archiveUrl=")) == 0) return 1
      return trusted(dec(substr(r, i + 15)))
    }
    function urlok(u,   h) {
      if (u !~ /^https?:\\/\\//) return 0
      h = substr(u, index(u, "//") + 2)
      sub(/[\\/?#].*/, "", h)
      sub(/.*@/, "", h)
      sub(/:[0-9]*$/, "", h)
      sub(/\\.+$/, "", h)
      h = tolower(h)
      if (h == "" || h ~ /%/ || h == "github.com" || h ~ /\\.github\\.com$/) return 0
      h = u
      sub(/#.*/, "", h)
      return tolower(h) !~ /\\.git$/
    }
    function srcok(r,   s) {
      s = r
      if (s ~ /^@/) { if (!sub(/^@[^\\/@]+\\/[^@]+@/, "", s)) return 0 }
      else if (!sub(/^[^@]+@/, "", s)) return 0
      if (s ~ /^npm:/) return substr(s, 5) ~ /^[0-9A-Za-z.+-]+(::__archiveUrl=[A-Za-z0-9%._~-]+)?$/
      if (s ~ /^(workspace|file|portal|link):/) return 1
      if (s ~ /^patch:/) return substr(s, 7) ~ /^(@[^\\/@]+\\/)?[^@\\/]+@(npm%3[Aa]([0-9A-Za-z.-]|%2[Bb])+|workspace%3[Aa][^#]*)(#|$)/
      return urlok(s)
    }
    function valok(v) {
      if (v ~ /^"[^"]*"$/) return 1
      return v ~ /^[A-Za-z0-9._\\/~^<=+]/ && index(v, " #") == 0 && index(v, ": ") == 0 && v !~ /:$/
    }
    function unq(v) { return v ~ /^"/ ? substr(v, 2, length(v) - 2) : v }
    BEGIN { lead = 1; hx = "0123456789abcdef" }
    { sub(/\\r$/, "") }
    /[^ -~]/ || /\\\\/ { fail("G", NR) }
    lead && /^#/ { if (tolower($0) ~ /^# +yarn +lockfile +v1$/) v1 = 1; next }
    { lead = 0 }
    /^ *$/ || /^#/ { next }
    {
      match($0, /^ */); ind = RLENGTH; line = substr($0, ind + 1)
      if (!started && ind != 0) fail("G", NR)
      if (started && ind > pind && !(pnov && ind == pind + 2)) fail("G", NR)
      if (v1) {
        if (ind == 0) {
          if (line !~ /^("[^"]*"|[^ ",:#][^ ",:]*)(, ("[^"]*"|[^ ",:]+))*:$/ || line ~ /__metadata/) fail("G", NR)
          dep = 0; nov = 1
        } else if (ind == 2) {
          if (line ~ /^"?(dependencies|optionalDependencies)"?:$/) { dep = 1; nov = 1 }
          else if (match(line, /^("(version|resolved|integrity|uid)"|version|resolved|integrity|uid) /)) {
            key = unq(substr(line, 1, RLENGTH - 1)); val = substr(line, RLENGTH + 1)
            if (val !~ /^("[^"]*"|[^ "]+)$/) fail("G", NR)
            if (key == "resolved") {
              val = unq(val)
              if (!urlok(val) && val !~ /^[^\\/:]+\\.tgz(#.*)?$/) fail("S", val)
              if (urlok(val) && !trusted(val)) fail("A", val)
            }
            dep = 0; nov = 0
          } else fail("G", NR)
        } else if (ind == 4 && dep && line ~ /^("[^"]*"|[^ "]+) ("[^"]*"|[^ "]+)$/) nov = 0
        else fail("G", NR)
      } else {
        if (ind == 0) {
          if (line != "__metadata:" && line !~ /^"[^"]*":$/) fail("G", NR)
          nov = 1
        } else {
          if (ind == 2 || ind == 6) re = "^[A-Za-z]+:"
          else if (ind == 4) re = "^(\\"[^\\"]*\\"|[A-Za-z0-9][A-Za-z0-9._-]*):"
          else fail("G", NR)
          if (!match(line, re)) fail("G", NR)
          key = substr(line, 1, RLENGTH - 1); val = substr(line, RLENGTH + 1)
          if (val == "") nov = 1
          else if (val !~ /^ / || !valok(substr(val, 2))) fail("G", NR)
          else { nov = 0; val = substr(val, 2) }
          if (ind == 2 && key == "resolved") fail("G", NR)
          if (ind == 2 && key == "resolution") {
            if (nov) fail("G", NR)
            if (!srcok(unq(val))) fail("S", unq(val))
            if (!archok(unq(val))) fail("A", unq(val))
          }
        }
      }
      pind = ind; pnov = nov; started = 1
    }
    ' "$f")
    or set out "G 1"
    if test -n "$out"
        printf '%s\n' "$out"
        return 0
    end
    return 1
end

# _safe_pkg_yarn_berry_check root subcmd
#   Prints why the wrapper will not run this command in the Yarn 2+ project at
#   root and succeeds; fails when it will. subcmd is what the walk in
#   yarn-wrapper.fish found (bash passes the arguments instead). See
#   _safe_pkg_yarn_berry_check in _safe_pkg_shared.sh for each reason.
function _safe_pkg_yarn_berry_check --argument root sub
    switch "$sub"
        case rebuild
            echo "yarn rebuild is not supported through the wrapper: it runs package build scripts outside an install, and the sandbox runs them only in the offline phase of one."
            return 0
        case focus
            echo "yarn workspaces focus is not supported through the wrapper: it has no fetch-only mode, so the sandbox cannot fetch with the network on and build with it off."
            return 0
        case link unlink
            echo "yarn $sub is not supported through the wrapper: in a Yarn 2+ project it changes package.json and runs an install outside the sandbox's two phases. Edit the portal: or link: dependency in package.json, then run yarn install."
            return 0
        case setresolution
            echo "yarn set resolution is not supported through the wrapper: it rewrites yarn.lock and runs an install outside the sandbox's two phases. Add the resolution to the resolutions field of package.json, then run yarn install."
            return 0
        case version
            echo "yarn version is not supported through the wrapper: it changes package.json and runs an install outside the sandbox's two phases. Change the version in package.json, then run yarn install. yarn version check still runs."
            return 0
        case packinstall
            echo "yarn pack --install-if-needed is not supported through the wrapper: it runs an install outside the sandbox's two phases. Run yarn install first, then yarn pack."
            return 0
        case upgradeinteractive
            echo "yarn upgrade-interactive is not supported through the wrapper: it asks questions, and the sandbox runs Yarn without a terminal. Use yarn up with the versions you want."
            return 0
    end
    set -l pm (_safe_pkg_yarn_berry_pin "$root")
    if test $status -ne 0
        # Shown in the message, so no byte a terminal would act on.
        set pm (printf '%s' "$pm" | LC_ALL=C tr -cd ' -~')
        if string match -qr -- '^yarn@[0-2](\..*)?$' "$pm"
            echo "$root/package.json pins "(string replace -r -- '\+.*' '' "$pm")", and the wrapper supports Yarn 3 or later: older releases cannot fetch without running build scripts (--mode=skip-build)."
        else if string match -q -- 'yarn@*' "$pm"
            echo "$root/package.json pins $pm, which is not an exact Yarn version, and the sandbox runs exactly the pinned release through corepack. Pin an exact version (yarn set version stable writes one) and run the command again."
        else
            echo "$root/package.json does not pin a Yarn version with packageManager, and the sandbox runs the pinned Yarn through corepack. Add the pin (yarn set version stable does) and run the command again."
        end
        return 0
    end
    for f in "$root/.yarnrc.yml" "$HOME/.yarnrc.yml"
        set -l n (_safe_pkg_yarnrc_plain "$f")
        if test $status -eq 0
            echo "$f has a line the wrapper cannot read safely (line $n): write each top-level setting as a plain name at the start of a line (key: value), not quoted, in braces or indented, use only printable ASCII and tabs, and run the command again."
            return 0
        end
        if test "$f" = "$root/.yarnrc.yml"
            set n (_safe_pkg_yarnrc_interp "$f")
            if test $status -eq 0
                echo "$f reads an environment variable or an escape (line $n), which the wrapper allows only in npmAuthToken and npmAuthIdent: Yarn fills \${VAR} in any setting, so a path setting could write the registry token into the project."
                return 0
            end
        end
        if _safe_pkg_yarnrc_set "$f" plugins
            echo "$f lists plugins, which the wrapper does not support: a plugin is code that runs inside Yarn while the registry token is available."
            return 0
        end
        if _safe_pkg_yarnrc_set "$f" lockfileFilename
            echo "$f sets lockfileFilename, so Yarn would write the lockfile somewhere other than the yarn.lock the scan checks."
            return 0
        end
        if _safe_pkg_yarnrc_set "$f" networkSettings
            echo "$f sets networkSettings, which the wrapper does not support: the sandbox sets its own to keep the fetch phase from downloading GitHub sources, and a setting here could override it."
            return 0
        end
    end
    set -l why (_safe_pkg_yarn_net_check "$root")
    and begin
        printf '%s\n' $why
        return 0
    end
    set why (_safe_pkg_yarn_manifest_check "$root")
    and begin
        printf '%s\n' $why
        return 0
    end
    set why (_safe_pkg_yarn_lock_check "$root/yarn.lock")
    and begin
        set -l detail (string replace -r -- '^[GAS] ' '' "$why")
        switch "$why"
            case 'G *'
                echo "$root/yarn.lock has a line the wrapper cannot read safely (line $detail): the checks read the layout Yarn writes, and other YAML could hide a dependency from them. Run yarn install with the bypass below to let Yarn rewrite the file, or restore it from git."
            case 'A *'
                echo "$root/yarn.lock downloads a package from a server that is not a registry in $HOME/.yarnrc.yml ($detail): Yarn sends the registry token with that download. If you trust the server, add it to $HOME/.yarnrc.yml as an npmRegistryServer (top-level or under npmScopes); otherwise remove the entry from yarn.lock. Then run the command again."
            case '*'
                echo "$root/yarn.lock resolves a dependency from a source the wrapper does not support ($detail): Yarn packs git and GitHub dependencies, and makes exec: ones, by running their scripts while it fetches, when the registry token is still available. Supported sources are the npm registry, workspaces, local folders and tarballs, patches of those, and tarball URLs off GitHub."
        end
        return 0
    end
    # The project's .yarnrc.yml wins over ~/.yarnrc.yml, as in Yarn, and
    # within one file the last line wins.
    set -l linker
    for f in "$root/.yarnrc.yml" "$HOME/.yarnrc.yml"
        if _safe_pkg_yarnrc_set "$f" nodeLinker
            set linker (command grep -E '^["\']?nodeLinker["\']?[[:space:]]*:' "$f" | tail -n 1 | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+#.*//; s/[[:space:]]+$//; s/^["\']//; s/["\']$//')
            break
        end
    end
    switch "$linker"
        case node-modules pnpm
            return 1
    end
    test -n "$linker"; or set linker "pnp, the default"
    echo "$root installs with Plug'n'Play (nodeLinker: $linker), which the wrapper does not support: the sandbox copies back node_modules, and Plug'n'Play has none. Set nodeLinker: node-modules in .yarnrc.yml and run the command again."
    return 0
end

# _safe_pkg_strip_yarnrc_yml_auth path
#   Removes the npmAuthToken and npmAuthIdent entries from a copied
#   .yarnrc.yml, with every deeper-indented line under one (a block scalar
#   holds its secret there), and a user:password@ in a URL. Returns 1 when it
#   fails; phase 2 must then not run. See _safe_pkg_shared.sh.
function _safe_pkg_strip_yarnrc_yml_auth --argument f
    test -f "$f"; or return 0
    if awk -v q="'" '
    BEGIN { re = "npmauth(token|ident)[\\"" q "]?[[:space:]]*:"; ui = "://[^/\\"" q " ]*@" }
    skip {
      if ($0 ~ /^[[:space:]]*$/) next
      match($0, /^[[:space:]]*/)
      if (RLENGTH > ind) next
      skip = 0
    }
    tolower($0) ~ re { match($0, /^[[:space:]]*/); ind = RLENGTH; skip = 1; next }
    { gsub(ui, "://"); print }
    ' "$f" >"$f.clean"; and mv "$f.clean" "$f"
        return 0
    end
    rm -f "$f.clean"
    echo "✗ safe-pnpm: could not remove the registry credentials from $f; the build phase did not run." >&2
    return 1
end

# _safe_pkg_yarn_berry_arch tmpdir
#   On a macOS host, adds the host's os and cpu next to "current" in
#   supportedArchitectures in the sandbox .yarnrc.yml (Yarn 2+ has no
#   --ignore-platform). A project that sets supportedArchitectures keeps its
#   own.
function _safe_pkg_yarn_berry_arch --argument tmpdir
    set -l f "$tmpdir/.yarnrc.yml"
    set -l oc (_safe_pkg_host_os_cpu)
    set -q oc[2]; or return 0
    _safe_pkg_yarnrc_set "$f" supportedArchitectures; and return 0
    # A last byte that is a newline leaves last empty. Not "$(...)": fish
    # before 3.4 cannot parse it, and this file would then define nothing.
    set -l last (tail -c 1 "$f" 2>/dev/null)
    if test -s "$f"; and test -n "$last"
        echo >>"$f"
    end
    printf 'supportedArchitectures:\n  os:\n    - current\n    - %s\n  cpu:\n    - current\n    - %s\n' $oc[1] $oc[2] >>"$f"
end

# _safe_pkg_yarn_berry_audit tmpdir workdir spec [docker-flags...]
#   The Yarn 2+ audit container for _safe_pkg_audit, with the network and
#   auth phase 1 had. `yarn npm audit` runs no package code. Like the fetch,
#   it loads no environment file: Yarn fills ${VAR} in rc values from
#   .env.yarn too, and this setting, read before any rc file, keeps a
#   project's injectEnvironmentFiles from undoing it.
function _safe_pkg_yarn_berry_audit --argument tmpdir workdir spec
    # Not $argv[4..]: fish before 3.2 has no open-ended range, and 4..-1
    # counts backwards when there is no fourth argument.
    set -l flags
    set -q argv[4]; and set flags $argv[4..-1]
    docker run --rm --cap-drop ALL $flags -e YARN_ENABLE_SCRIPTS=0 \
        -e "YARN_INJECT_ENVIRONMENT_FILES=/nonexistent/.env.yarn?" \
        -v "$tmpdir:/app" -w "$workdir" \
        safe-pnpm:latest corepack "$spec" npm audit --all --recursive --severity moderate
end

# _safe_pkg_copy_modules tmpdir member workspace_root
#   Copies tmpdir/member/node_modules to the same place under workspace_root
#   (member "" is the root), only when the source resolves to exactly that
#   path and its links stay inside the project. Returns 1 when it refuses.
#   See _safe_pkg_copy_modules in _safe_pkg_shared.sh.
function _safe_pkg_copy_modules --argument base member dest_root
    set -l rel node_modules
    test -n "$member"; and set rel "$member/node_modules"
    set -l src "$base/$rel"
    test -e "$src"; or test -L "$src"; or return 0
    # builtin realpath, not `path resolve`, which fish before 3.5 lacks.
    set -l want (builtin realpath -- "$base" | string collect)/$rel
    set -l got (builtin realpath -- "$src" 2>/dev/null | string collect)
    if not test -d "$src"; or test -L "$src"; or test "$got" != "$want"
        echo "✗ safe-pnpm: sandbox $rel is not a plain directory; not copied back." >&2
        return 1
    end
    _safe_pkg_links_ok "$base" "$rel"; or return 1
    test -n "$dest_root"; or return 1
    rm -rf "$dest_root/$rel"
    if not cp -R "$src" "$dest_root/$rel"
        echo "✗ safe-pnpm: copying $rel back failed; the previous $rel was already removed." >&2
        return 1
    end
end

# _safe_pkg_yarn_berry_run root [yarn-args...]
#   The Yarn 2+ sandbox, after _safe_pkg_yarn_berry_check passed: the pinned
#   Yarn runs through corepack at the project root, from the member folder
#   the command was run in. See the berry parts of _safe_pkg_sandbox in
#   _safe_pkg_shared.sh.
function _safe_pkg_yarn_berry_run --argument root
    set -l args
    set -q argv[2]; and set args $argv[2..-1]
    set -l spec (_safe_pkg_yarn_berry_pin "$root")
    or begin
        echo "✗ safe-pnpm: $root/package.json does not pin an exact Yarn 3+ version with packageManager." >&2
        return 1
    end

    # Both containers run as the invoking user, not root (see yarn-wrapper.fish).
    set -l user_flags (_safe_pkg_user_flags)
    or return 1

    set -l rel (string sub -s (math (string length -- "$root") + 2) -- "$PWD" | string collect)
    set -l workdir /app
    test -n "$rel"; and set workdir "/app/$rel"

    set -l tmpdir (mktemp -d)
    # Host-only, never mounted into a container: the post-fetch manifest
    # snapshots that copy-back reads from.
    set -l snapdir (mktemp -d)
    _safe_pkg_track $tmpdir $snapdir
    set -l members

    pushd "$root" >/dev/null
    or begin
        _safe_pkg_untrack $tmpdir $snapdir
        return 1
    end
    for f in package.json yarn.lock .yarnrc .npmrc .yarnrc.yml
        test -f $f; and cp $f $tmpdir/
    end
    # Yarn 2+ keeps its workspace list in package.json, so members are always
    # looked for. .yarn holds Yarn's own files, never a member, and the
    # sandbox's own folders would collide with the copies. NUL-separated, so
    # a folder name with a newline or edge spaces stays whole.
    for pkg in (find . -mindepth 2 -name package.json -not -path "*/node_modules/*" -not -path "./.yarn/*" \
            -not -path "./.corepack/*" -not -path "./.safe-home/*" -not -path "./.safe-store/*" -print0 | string split0)
        # string collect keeps a newline in the name from splitting it.
        set -l member (string replace -r -- '(?s)^\./(.+)/package\.json\z' '$1' $pkg | string collect)
        test -n "$member"; or continue
        mkdir -p "$tmpdir/$member"
        cp "$pkg" "$tmpdir/$member/"
        set members $members $member
    end
    # patch: dependencies read their diffs from here during the fetch. Only
    # regular .patch files in real folders: a symlink could bring any file on
    # this machine into the sandbox, where build scripts read it.
    if not test -L .yarn; and test -d .yarn/patches; and not test -L .yarn/patches
        mkdir -p $tmpdir/.yarn/patches
        for f in .yarn/patches/*.patch
            if test -f $f; and not test -L $f
                cp $f $tmpdir/.yarn/patches/
            end
        end
    end
    popd >/dev/null

    # The containers get a copy of ~/.yarnrc.yml as their home's, stripped
    # before phase 2. It ends with networkSettings that refuse github.com, so
    # a GitHub dependency added in phase 1 cannot be downloaded and packed
    # there; _safe_pkg_yarn_berry_check refuses a networkSettings of the
    # user's own, which could override it.
    mkdir -p $tmpdir/.safe-home
    set -l home_rc $tmpdir/.safe-home/.yarnrc.yml
    if test -f "$HOME/.yarnrc.yml"
        cp "$HOME/.yarnrc.yml" $home_rc
        set -l last (tail -c 1 $home_rc 2>/dev/null)
        if test -s $home_rc; and test -n "$last"
            printf '\n' >>$home_rc
        end
    end
    printf '%s\n' 'networkSettings:' '  "github.com":' '    enableNetwork: false' >>$home_rc

    set -l hardening --security-opt no-new-privileges --pids-limit 1024
    test -n "$SAFE_PNPM_MEMORY"; and set hardening $hardening --memory $SAFE_PNPM_MEMORY

    # Every container: corepack keeps the pinned Yarn in the sandbox, so phase
    # 2 runs it offline; yarnPath is ignored, so the version is the pin
    # corepack verifies; the package cache sits in the sandbox; no telemetry.
    # HOME is set even under rootless Docker, where user_flags leaves it out,
    # so Yarn finds the sandbox ~/.yarnrc.yml.
    set -l berry_env -e COREPACK_HOME=/app/.corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e YARN_IGNORE_PATH=1 \
        -e YARN_CACHE_FOLDER=/app/.safe-store -e YARN_ENABLE_GLOBAL_CACHE=0 -e YARN_ENABLE_TELEMETRY=0
    string match -q -- 'HOME=*' $user_flags; or set berry_env $berry_env -e HOME=/app/.safe-home

    # Tokens are forwarded only into the fetch and audit, where no package
    # code runs. They are never present during phase 2.
    set -l token_env
    test -n "$NODE_AUTH_TOKEN"; and set token_env $token_env -e NODE_AUTH_TOKEN
    test -n "$NPM_TOKEN"; and set token_env $token_env -e NPM_TOKEN
    set token_env $token_env (_safe_pkg_user_auth $tmpdir)

    _safe_pkg_yarn_berry_arch $tmpdir

    # Phase 1: fetch. --mode=skip-build resolves and fetches without running
    # any build script, and YARN_ENABLE_SCRIPTS=0 also stops a workspace's
    # exec: dependency. Bare `yarn` is an install.
    set -l fetch_args $args
    set -q fetch_args[1]; or set fetch_args install
    docker run --rm --cap-drop ALL $hardening $user_flags -v "$tmpdir:/app" -w $workdir $token_env $berry_env \
        -e YARN_ENABLE_SCRIPTS=0 -e "YARN_INJECT_ENVIRONMENT_FILES=/nonexistent/.env.yarn?" \
        safe-pnpm:latest corepack $spec $fetch_args --mode=skip-build
    set -l rc $status

    # Known-malware check on the tree phase 1 resolved, before any package
    # code runs. A hit discards the sandbox: nothing is built or copied back.
    set -l fetched 0
    if test $rc -eq 0
        if _safe_pkg_malware_scan "$tmpdir/yarn.lock"
            set fetched 1
        else
            set rc 1
        end
    end

    # Snapshot manifests and lockfile before phase 2, which can rewrite
    # anything under /app; copy-back reads them from here. Then the CVE
    # audit, in a container: the host yarn may be Yarn 1 or none, and the
    # project's Yarn must not run there.
    if test $fetched -eq 1
        mkdir -p $snapdir/tree
        for f in package.json yarn.lock
            test -f $tmpdir/$f; and cp $tmpdir/$f $snapdir/tree/$f
        end
        for m in $members
            if test -f "$tmpdir/$m/package.json"
                mkdir -p "$snapdir/tree/$m"
                cp "$tmpdir/$m/package.json" "$snapdir/tree/$m/package.json"
            end
        end
        if not _safe_pkg_audit yarn yarn.lock $snapdir/tree $tmpdir \
                _safe_pkg_yarn_berry_audit $tmpdir $workdir $spec $hardening $user_flags $token_env $berry_env
            set fetched 0
            set rc 1
        end
    end

    # Strip registry credentials before any build script can run.
    if test $fetched -eq 1
        _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
        _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"
        rm -f $tmpdir/.safe-home/.npmrc
        if not _safe_pkg_strip_yarnrc_yml_auth "$tmpdir/.yarnrc.yml"; or not _safe_pkg_strip_yarnrc_yml_auth "$tmpdir/.safe-home/.yarnrc.yml"
            set fetched 0
            set rc 1
        end
    end

    # Phase 2: build from the phase 1 cache with the lockfile it wrote (no
    # token, no auth lines, network off by default). Yarn and corepack stay
    # offline even under SAFE_PNPM_BUILD_NETWORK=1.
    if test $fetched -eq 1
        set -l net_flag --network none
        test "$SAFE_PNPM_BUILD_NETWORK" = 1; and set net_flag
        docker run --rm --cap-drop ALL $hardening $user_flags $net_flag -v "$tmpdir:/app" -w $workdir $berry_env \
            -e YARN_ENABLE_NETWORK=0 -e COREPACK_ENABLE_NETWORK=0 \
            safe-pnpm:latest corepack $spec install --immutable
        set rc $status
    end

    # Copy back whenever the fetch passed the scans: the tree exists even if a
    # build script failed, and the non-zero rc still surfaces. Only
    # node_modules at the root and in pre-existing members come back.
    if test $fetched -eq 1
        set -l has_modules 0
        set -l copy_rc 0
        set -l t0 (date +%s)
        test -e $tmpdir/node_modules; and set has_modules 1
        for m in $members
            test -e "$tmpdir/$m/node_modules"; and set has_modules 1
        end
        test $has_modules -eq 1; and echo "→ Copying node_modules back to the project (can take a minute; don't interrupt)..." >&2
        _safe_pkg_copy_modules $tmpdir "" $root; or set copy_rc 1
        for m in $members
            _safe_pkg_copy_modules $tmpdir $m $root; or set copy_rc 1
        end
        if test $copy_rc -eq 0; and test $has_modules -eq 1
            echo "→ Copied node_modules back in "(math (date +%s) - $t0)"s." >&2
        end
        test $copy_rc -eq 0; or set rc 1
        for f in package.json yarn.lock
            test -f $snapdir/tree/$f; and cp $snapdir/tree/$f $root/$f
        end
        for m in $members
            test -f "$snapdir/tree/$m/package.json"; and cp "$snapdir/tree/$m/package.json" "$root/$m/package.json"
        end
    end

    _safe_pkg_untrack $tmpdir $snapdir
    return $rc
end
