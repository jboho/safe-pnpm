# yarn Docker isolation wrapper — PowerShell
# Add to your profile: . ~/.safe-pnpm/yarn-wrapper.ps1
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class yarn commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: yarn.cmd install bypasses to native yarn.
# Note: yarn v1 only. berry (v2+) requires separate handling.

. "$HOME\.safe-pnpm\_safe_pkg_shared.ps1"

function global:yarn {
    $installCmds = @('install','add','remove','upgrade')
    $cmd = if ($args.Count -gt 0) { $args[0] } else { '' }

    if ($cmd -notin $installCmds) {
        $yarnExe = (Get-Command yarn -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        & $yarnExe @args
        return
    }

    # Extract the safe-pnpm-only --socket flag so it never reaches yarn.
    $socketFlag = $args -contains '--socket'
    $passArgs = @($args | Where-Object { $_ -ne '--socket' })

    if (-not (_Safe_Pkg_Prescan -Manager yarn -Lockfile 'yarn.lock' -Socket:$socketFlag)) { return }

    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native yarn? [y/N]"
        if ($ans -match '^[Yy]') {
            $yarnExe = (Get-Command yarn -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
            & $yarnExe @passArgs
        }
        return
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    foreach ($f in @('package.json','yarn.lock','.yarnrc','.npmrc')) {
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
    $dockerArgs += @('safe-pnpm:latest','yarn') + $passArgs

    & docker @dockerArgs
    $rc = $LASTEXITCODE

    if ($rc -eq 0) {
        $srcModules = Join-Path $tmpDir.FullName "node_modules"
        if (Test-Path $srcModules) {
            if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
            Copy-Item -Recurse $srcModules (Get-Location).Path
        }
        $srcLock = Join-Path $tmpDir.FullName "yarn.lock"
        if (Test-Path $srcLock) { Copy-Item $srcLock (Get-Location).Path }
    }

    Remove-Item -Recurse -Force $tmpDir.FullName
    $global:LASTEXITCODE = $rc
}
