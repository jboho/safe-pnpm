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

    if (-not (_Safe_Pkg_Prescan -Manager npm -Lockfile 'package-lock.json')) { return }

    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native npm? [y/N]"
        if ($ans -match '^[Yy]') {
            $npmExe = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
            & $npmExe @args
        }
        return
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    foreach ($f in @('package.json','package-lock.json','.npmrc')) {
        if (Test-Path $f) { Copy-Item $f $tmpDir.FullName }
    }

    $dockerArgs = @('run','--rm','--cap-drop','ALL',
        '-v', "$($tmpDir.FullName):/app",
        '-w', '/app')
    # Forward registry tokens only on explicit opt-in — untrusted lifecycle
    # scripts run in the container and could exfiltrate them otherwise.
    if ($env:SAFE_PNPM_FORWARD_TOKENS -eq '1') {
        if ($env:NODE_AUTH_TOKEN) { $dockerArgs += @('-e','NODE_AUTH_TOKEN') }
        if ($env:NPM_TOKEN)       { $dockerArgs += @('-e','NPM_TOKEN') }
    }
    $dockerArgs += @('safe-pnpm:latest','npm') + $args

    & docker @dockerArgs
    $rc = $LASTEXITCODE

    if ($rc -eq 0) {
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
