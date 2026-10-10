# npm Docker isolation wrapper — PowerShell
# Add to your profile: . ~/.safe-pnpm/npm-wrapper.ps1
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class npm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: npm.cmd install bypasses to native npm.

. "$HOME\.safe-pnpm\_safe_pkg_shared.ps1"

function global:npm {
    $installCmds = @('install','i','in','ins','inst','insta','instal','isnt','isnta','isntal','isntall','add','ci','clean-install','ic','install-clean','isntall-clean','install-test','it','cit','install-ci-test','sit','clean-install-test','update','up','upgrade','udpate','u','uninstall','un','unlink','remove','rm','r')
    $nativeCmds = @('run','run-script','rum','urn','test','t','tst','start','stop','restart','exec','x','publish','pack','version','v','view','info','show','config','c','get','set','ls','list','la','ll','audit','outdated','login','logout','whoami','init','create','innit','pkg','prefix','root','bin','docs','help','ping','search','team','token','owner','access','dist-tag','deprecate','cache','link','ln','rebuild','rb','dedupe','find-dupes','explain','why','fund','diff','doctor')
    $valueFlags = @('--prefix','-w','--workspace','--registry','--cache','--userconfig','--globalconfig','--loglevel','--otp','--scope','--omit','--include','--install-strategy','--tag','--before','--audit-level','--fetch-retries','--lockfile-version','--min-release-age','--cpu','--os','--libc','--script-shell','--node-options','--maxsockets')
    $installN = @($installCmds | ForEach-Object { $_ -replace '-','' })
    $nativeN = @($nativeCmds | ForEach-Object { $_ -replace '-','' })
    # Walk the non-flag words: an install word or alias is the subcommand, a
    # known non-install command means native, and anything else may be the value
    # of a flag missing from $valueFlags, so try the next word (fails closed).
    $cmd = ''
    $seen = 0
    $skip = $false
    foreach ($a in $args) {
        if ($skip) { $skip = $false; continue }
        if ($a -eq '--') { break }
        if ($a -like '-*=*') { continue }
        if ($a -like '-*') { if ($valueFlags -ccontains $a) { $skip = $true }; continue }
        $n = $a.ToLower() -replace '-',''
        if (-not $n) { continue }
        $seen = 1
        if ($nativeN -contains $n) { break }
        if ($installN -contains $n) { $cmd = $n; break }
        if ($n.Length -ge 2 -and ($installN | Where-Object { $_.StartsWith($n) })) { $cmd = $n; break }
    }
    if (-not $cmd) {
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
        _Safe_Pkg_Native_Fallback -Manager npm -PassArgs $passArgs
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
        $p1 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + @('-v',"$($tmpDir.FullName):/app",'-w','/app') +
            $tokenEnv + @('safe-pnpm:latest','npm') + $passArgs + @('--ignore-scripts') + $storeFlag
        & docker @p1
        $rc = $LASTEXITCODE

        # Known-malware check on the tree phase 1 resolved, before any package
        # code runs. A hit discards the sandbox: nothing is built or copied back.
        if ($rc -eq 0 -and -not (_Safe_Pkg_Malware_Scan (Join-Path $tmpDir.FullName 'package-lock.json'))) { $rc = 1 }

        if ($rc -eq 0) {
            $manifests = @('package.json','package-lock.json')
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit on the resolved tree, after the snapshot and before any
            # build script. A block discards the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit npm 'package-lock.json' $snapDir.FullName $tmpDir.FullName)) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no .npmrc auth, network off by default).
            $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + $netFlag +
                @('-v',"$($tmpDir.FullName):/app",'-w','/app','safe-pnpm:latest','npm','rebuild') + $storeFlag
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
