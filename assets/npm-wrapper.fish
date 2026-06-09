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

    _safe_pkg_prescan npm package-lock.json
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native npm? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command npm $argv
            else
                return 1
            end
        else
            command npm $argv
        end
        return
    end

    set -l tmpdir (mktemp -d)

    for f in package.json package-lock.json .npmrc
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
    set docker_args $docker_args safe-pnpm:latest npm

    docker $docker_args $argv
    set -l rc $status

    if test $rc -eq 0
        if test -d "$tmpdir/node_modules"
            rm -rf node_modules
            cp -r "$tmpdir/node_modules" node_modules
        end
        if test -f "$tmpdir/package-lock.json"
            cp "$tmpdir/package-lock.json" package-lock.json
        end
    end

    rm -rf $tmpdir
    return $rc
end
