# npm Docker isolation wrapper — PowerShell
# Add to your profile: . ~/.safe-pnpm/npm-wrapper.ps1
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: npm.cmd install bypasses to native npm.

. "$HOME\.safe-pnpm\_safe_pkg_shared.ps1"

function global:npm {
    $installCmds = @('install','i','ci','update','uninstall','un')
    $cmd = if ($args.Count -gt 0) { $args[0] } else { '' }

    if ($cmd -notin $installCmds) {
        $npmExe = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        & $npmExe @args
        return
    }

    # Extract the safe-pnpm-only --socket flag so it never reaches npm.
    $socketFlag = $args -contains '--socket'
    $passArgs = @($args | Where-Object { $_ -ne '--socket' })

    if (-not (_Safe_Pkg_Prescan -Manager npm -Lockfile 'package-lock.json' -Socket:$socketFlag)) { return }

    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native npm? [y/N]"
        if ($ans -match '^[Yy]') {
            $npmExe = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
            & $npmExe @passArgs
        }
        return
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    foreach ($f in @('package.json','package-lock.json','.npmrc')) {
        if (Test-Path $f) { Copy-Item $f $tmpDir.FullName }
    }

    # Per-manager cache kept under /app so phase 2 resolves fully offline.
    $storeFlag = @('--cache','/app/.safe-store')

    # Tokens are forwarded only into the fetch phase, where --ignore-scripts
    # guarantees no package code runs. They are never present during phase 2.
    $tokenEnv = @()
    if ($env:NODE_AUTH_TOKEN) { $tokenEnv += @('-e','NODE_AUTH_TOKEN') }
    if ($env:NPM_TOKEN)       { $tokenEnv += @('-e','NPM_TOKEN') }

    # Phase 1: fetch (network on, token available, scripts disabled).
    $p1 = @('run','--rm','--cap-drop','ALL','-v',"$($tmpDir.FullName):/app",'-w','/app') +
        $tokenEnv + @('safe-pnpm:latest','npm') + $passArgs + @('--ignore-scripts') + $storeFlag
    & docker @p1
    $rc = $LASTEXITCODE

    if ($rc -eq 0) {
        # Strip registry credentials before any build script can run.
        _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')

        $netFlag = @('--network','none')
        if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

        # Phase 2: build (no token, no .npmrc auth, network off by default).
        $p2 = @('run','--rm','--cap-drop','ALL') + $netFlag +
            @('-v',"$($tmpDir.FullName):/app",'-w','/app','safe-pnpm:latest','npm','rebuild') + $storeFlag
        & docker @p2
        $rc = $LASTEXITCODE

        $srcModules = Join-Path $tmpDir.FullName "node_modules"
        if (Test-Path $srcModules) {
            if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
            Copy-Item -Recurse $srcModules (Get-Location).Path
        }
        $srcLock = Join-Path $tmpDir.FullName "package-lock.json"
        if (Test-Path $srcLock) { Copy-Item $srcLock (Get-Location).Path }
    }

    Remove-Item -Recurse -Force $tmpDir.FullName
    $global:LASTEXITCODE = $rc
}
