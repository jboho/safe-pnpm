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
    $installCmds = @('install','add','remove','upgrade','upgrade-interactive')
    $nativeCmds = @('run','test','start','publish','pack','create','init','list','ls','info','why','outdated','audit','cache','check','config','link','unlink','login','logout','owner','tag','team','version','versions','bin','generate-lock-entry','import','licenses','autoclean','help','exec','node')
    $valueFlags = @('--cwd','--registry','--modules-folder','--cache-folder','--preferred-cache-folder','--global-folder','--link-folder','--network-concurrency','--network-timeout','--proxy','--https-proxy','--mutex','--use-yarnrc','--cafile','--otp')
    $installN = @($installCmds | ForEach-Object { $_ -replace '-','' })
    $nativeN = @($nativeCmds | ForEach-Object { $_ -replace '-','' })
    # Walk the non-flag words: an install word or alias is the subcommand, a
    # known non-install command means native, and anything else may be the value
    # of a flag missing from $valueFlags, so try the next word (fails closed).
    $cmd = ''
    $seen = 0
    $g = $false
    $skip = $false
    foreach ($a in $args) {
        if ($skip) { $skip = $false; continue }
        if ($a -eq '--') { break }
        if ($a -like '-*=*') { continue }
        if ($a -like '-*') { if ($valueFlags -ccontains $a) { $skip = $true }; continue }
        $n = $a.ToLower() -replace '-',''
        if (-not $n) { continue }
        $seen = 1
        # yarn v1 spells a global install as a subcommand; only the mutating
        # ones are install-class (refused below), `yarn global list` is not.
        if ($g) { if ($n -in 'add','remove','upgrade') { $cmd = 'global' }; break }
        if ($n -eq 'global') { $g = $true; continue }
        if ($nativeN -contains $n) { break }
        if ($installN -contains $n) { $cmd = $n; break }
    }
    if ($seen -eq 0) {
        $cmd = 'install'
        if ($args | Where-Object { $_ -in '-v','--version','-h','--help' }) { $cmd = '' }
    }
    if (-not $cmd) {
        $yarnExe = (Get-Command yarn -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        & $yarnExe @args
        return
    }

    # Extract the safe-pnpm-only --socket flag so it never reaches yarn.
    $socketFlag = $args -contains '--socket'
    $passArgs = @($args | Where-Object { $_ -ne '--socket' })

    if (_Safe_Pkg_Is_Global $passArgs) {
        Write-Host "✗ safe-pnpm: global installs are not supported through the wrapper; the sandbox would install into a throwaway container and change nothing on this machine." -ForegroundColor Red
        Write-Host "  To install globally without the safety checks, run: yarn.cmd $passArgs" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        return
    }

    if (-not (_Safe_Pkg_Prescan -Manager yarn -Lockfile 'yarn.lock' -Socket:$socketFlag)) { return }

    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        _Safe_Pkg_Native_Fallback -Manager yarn -PassArgs $passArgs
        return
    }

    try { $userFlags = @(_Safe_Pkg_User) } catch {
        Write-Host "✗ $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        return
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }
    # Host-only, never mounted into a container: the post-fetch manifest
    # snapshots that copy-back reads from.
    $snapDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    # tmpDir holds a copy of .npmrc (registry token); remove both dirs even if the
    # run is interrupted with Ctrl-C.
    try {

        foreach ($f in @('package.json','yarn.lock','.yarnrc','.npmrc')) {
            if (Test-Path $f) { Copy-Item $f $tmpDir.FullName }
        }

        # Per-manager cache kept under /app so phase 2 resolves fully offline.
        $storeFlag = @('--cache-folder','/app/.safe-store')

        # Tokens are forwarded only into the fetch phase, where --ignore-scripts
        # guarantees no package code runs. They are never present during phase 2.
        $tokenEnv = @()
        if ($env:NODE_AUTH_TOKEN) { $tokenEnv += @('-e','NODE_AUTH_TOKEN') }
        if ($env:NPM_TOKEN)       { $tokenEnv += @('-e','NPM_TOKEN') }

        # Phase 1: fetch (network on, token available, scripts disabled).
        $p1 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + @('-v',"$($tmpDir.FullName):/app",'-w','/app') +
            $tokenEnv + @('safe-pnpm:latest','yarn') + $passArgs + @('--ignore-scripts') + $storeFlag
        & docker @p1
        $rc = $LASTEXITCODE

        # Known-malware check on the tree phase 1 resolved, before any package
        # code runs. A hit discards the sandbox: nothing is built or copied back.
        if ($rc -eq 0 -and -not (_Safe_Pkg_Malware_Scan (Join-Path $tmpDir.FullName 'yarn.lock'))) { $rc = 1 }

        if ($rc -eq 0) {
            $manifests = @('package.json','yarn.lock')
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit on the resolved tree, after the snapshot and before any
            # build script. A block discards the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit yarn 'yarn.lock' $snapDir.FullName $tmpDir.FullName)) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + $netFlag +
                @('-v',"$($tmpDir.FullName):/app",'-w','/app','safe-pnpm:latest','yarn','install','--offline','--force') + $storeFlag
            & docker @p2
            $rc = $LASTEXITCODE

            if (-not (_Safe_Pkg_Copy_Modules -Base $tmpDir.FullName -Rel 'node_modules' -DestRoot (Get-Location).Path)) { $rc = 1 }
            _Safe_Pkg_Copy_Files -From $snapDir.FullName -To (Get-Location).Path -RelPaths $manifests
        }

        $global:LASTEXITCODE = $rc
    } finally {
        Remove-Item -Recurse -Force $tmpDir.FullName, $snapDir.FullName -ErrorAction SilentlyContinue
    }
}
