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

    _safe_pkg_prescan yarn yarn.lock
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native yarn? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command yarn $argv
            else
                return 1
            end
        else
            command yarn $argv
        end
        return
    end

    set -l tmpdir (mktemp -d)

    for f in package.json yarn.lock .yarnrc .npmrc
        if test -f $f
            cp $f $tmpdir/
        end
    end

    set -l docker_args run --rm --cap-drop ALL -v "$tmpdir:/app" -w /app
    if test -n "$NODE_AUTH_TOKEN"
        set docker_args $docker_args -e NODE_AUTH_TOKEN
    end
    if test -n "$NPM_TOKEN"
        set docker_args $docker_args -e NPM_TOKEN
    end
    set docker_args $docker_args safe-pnpm:latest yarn

    docker $docker_args $argv
    set -l rc $status

    if test $rc -eq 0
        if test -d "$tmpdir/node_modules"
            rm -rf node_modules
            cp -r "$tmpdir/node_modules" node_modules
        end
        if test -f "$tmpdir/yarn.lock"
            cp "$tmpdir/yarn.lock" yarn.lock
        end
    end

    rm -rf $tmpdir
    return $rc
end
