# pnpm Docker isolation wrapper — PowerShell
# Add to your profile: . ~/.safe-pnpm/pnpm-wrapper.ps1
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: pnpm.cmd install bypasses to native pnpm.

. "$HOME\.safe-pnpm\_safe_pkg_shared.ps1"

function global:pnpm {
    $installCmds = @('install','add','update','ci','remove','fetch')
    $cmd = if ($args.Count -gt 0) { $args[0] } else { '' }

    if ($cmd -notin $installCmds) {
        $pnpmExe = (Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        & $pnpmExe @args
        return
    }

    # Extract the safe-pnpm-only --socket flag so it never reaches pnpm.
    $socketFlag = $args -contains '--socket'
    $passArgs = @($args | Where-Object { $_ -ne '--socket' })

    if (-not (_Safe_Pkg_Prescan -Manager pnpm -Lockfile 'pnpm-lock.yaml' -Socket:$socketFlag)) { return }

    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native pnpm? [y/N]"
        if ($ans -match '^[Yy]') {
            $pnpmExe = (Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
            & $pnpmExe @passArgs
        }
        return
    }

    $workspaceRoot = (Get-Location).Path
    $relPath = ""
    $d = (Get-Location).Path
    $root = [IO.Path]::GetPathRoot($d)
    while ($d -ne $HOME -and $d -ne $root) {
        if (Test-Path (Join-Path $d "pnpm-workspace.yaml")) {
            $workspaceRoot = $d
            $relPath = (Get-Location).Path.Substring($d.Length).TrimStart([char]'\', [char]'/')
            break
        }
        $d = Split-Path $d -Parent
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    Push-Location $workspaceRoot
    foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc')) {
        if (Test-Path $f) { Copy-Item $f $tmpDir.FullName }
    }
    if (Test-Path "pnpm-workspace.yaml") {
        Get-ChildItem -Recurse -Filter "package.json" |
            Where-Object { $_.FullName -notmatch [regex]::Escape("node_modules") -and
                           $_.DirectoryName -ne $workspaceRoot } |
            ForEach-Object {
                $dest = Join-Path $tmpDir.FullName ($_.DirectoryName.Substring($workspaceRoot.Length).TrimStart([char]'\', [char]'/'))
                New-Item -Type Directory -Force $dest | Out-Null
                Copy-Item $_.FullName $dest
            }
    }
    Pop-Location

    $workdir = if ($relPath) { "/app/$($relPath -replace '\\','/')" } else { "/app" }
    # Per-manager store kept under /app so phase 2 resolves fully offline.
    $storeFlag = @('--config.store-dir=/app/.safe-store')

    # Tokens are forwarded only into the fetch phase, where --ignore-scripts
    # guarantees no package code runs. They are never present during phase 2.
    $tokenEnv = @()
    if ($env:NODE_AUTH_TOKEN) { $tokenEnv += @('-e','NODE_AUTH_TOKEN') }
    if ($env:NPM_TOKEN)       { $tokenEnv += @('-e','NPM_TOKEN') }

    # Phase 1: fetch (network on, token available, scripts disabled).
    $p1 = @('run','--rm','--cap-drop','ALL','-v',"$($tmpDir.FullName):/app",'-w',$workdir) +
        $tokenEnv + @('safe-pnpm:latest','pnpm') + $passArgs + @('--ignore-scripts') + $storeFlag
    & docker @p1
    $rc = $LASTEXITCODE

    if ($rc -eq 0) {
        # `pnpm fetch` only populates the store; there is nothing to build.
        if ($cmd -ne 'fetch') {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')

            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            $p2 = @('run','--rm','--cap-drop','ALL') + $netFlag +
                @('-v',"$($tmpDir.FullName):/app",'-w',$workdir,'safe-pnpm:latest','pnpm','install','--offline','--trust-lockfile') + $storeFlag
            & docker @p2
            $rc = $LASTEXITCODE
        }

        $srcModules = Join-Path $tmpDir.FullName "node_modules"
        if (Test-Path $srcModules) {
            $destModules = Join-Path $workspaceRoot "node_modules"
            if (Test-Path $destModules) { Remove-Item -Recurse -Force $destModules }
            Copy-Item -Recurse $srcModules $workspaceRoot
        }
        $srcLock = Join-Path $tmpDir.FullName "pnpm-lock.yaml"
        if (Test-Path $srcLock) { Copy-Item $srcLock $workspaceRoot }

        if (Test-Path (Join-Path $workspaceRoot "pnpm-workspace.yaml")) {
            Get-ChildItem -Recurse -Directory -Filter "node_modules" -Path $tmpDir.FullName |
                Where-Object { $_.FullName -ne $srcModules -and
                               $_.FullName -notmatch [regex]::Escape([IO.Path]::DirectorySeparatorChar + '.safe-store' + [IO.Path]::DirectorySeparatorChar) } |
                ForEach-Object {
                    $rel = $_.FullName.Substring($tmpDir.FullName.Length).TrimStart([char]'\', [char]'/')
                    $dest = Join-Path $workspaceRoot $rel
                    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
                    New-Item -Type Directory -Force (Split-Path $dest -Parent) | Out-Null
                    Copy-Item -Recurse $_.FullName $dest
                }
        }
    }

    Remove-Item -Recurse -Force $tmpDir.FullName
    $global:LASTEXITCODE = $rc
}
