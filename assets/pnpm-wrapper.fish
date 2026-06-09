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

    _safe_pkg_prescan pnpm pnpm-lock.yaml
    or return 1

    if not docker info >/dev/null 2>&1
        if isatty stdin
            read --prompt-str "⚠️  safe-pnpm: Docker not running. Use native pnpm? [y/N] " _ans
            if string match -qi 'y*' "$_ans"
                command pnpm $argv
            else
                return 1
            end
        else
            command pnpm $argv
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

    set -l docker_args run --rm --cap-drop ALL -v "$tmpdir:/app" -w $workdir
    if test -n "$NODE_AUTH_TOKEN"
        set docker_args $docker_args -e NODE_AUTH_TOKEN
    end
    if test -n "$NPM_TOKEN"
        set docker_args $docker_args -e NPM_TOKEN
    end
    set docker_args $docker_args safe-pnpm:latest pnpm

    docker $docker_args $argv
    set -l rc $status

    if test $rc -eq 0
        if test -d "$tmpdir/node_modules"
            rm -rf "$workspace_root/node_modules"
            cp -r "$tmpdir/node_modules" "$workspace_root/node_modules"
        end
        if test -f "$tmpdir/pnpm-lock.yaml"
            cp "$tmpdir/pnpm-lock.yaml" "$workspace_root/pnpm-lock.yaml"
        end
        if test -f "$workspace_root/pnpm-workspace.yaml"
            for nm in (find $tmpdir -mindepth 2 -name node_modules -type d)
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
