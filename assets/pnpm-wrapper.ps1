# pnpm Docker isolation wrapper — PowerShell
# Add to your profile: . ~/.safe-pnpm/pnpm-wrapper.ps1
# (safe-pnpm setup handles this automatically)
#
# Intercepts install-class pnpm commands and runs them in an isolated Docker
# container that only sees package manifests (no source files, no .env).
# Escape hatch: pnpm.cmd install bypasses to native pnpm.

. "$HOME\.safe-pnpm\_safe_pkg_shared.ps1"

function global:pnpm {
    $installCmds = @('install','i','add','update','up','upgrade','ci','clean-install','ic','install-clean','fetch','remove','rm','un','uninstall','uni','install-test','it','unlink','dislink')
    $nativeCmds = @('run','exec','dlx','test','t','start','stop','restart','publish','pack','list','ls','ll','la','why','outdated','audit','config','c','get','set','init','create','link','ln','rebuild','rb','approve-builds','store','root','bin','patch','patch-commit','patch-remove','import','prune','dedupe','deploy','licenses','help','env','self-update','setup','doctor','server','cat-file','cat-index','find-hash')
    $valueFlags = @('-C','--dir','-F','--filter','--filter-prod','--workspace-dir','--reporter','--loglevel','--config','--store-dir','--state-dir','--registry','--lockfile-dir','--network-concurrency','--fetch-timeout','--workspace-concurrency','--test-pattern','--changed-files-ignore-pattern','--http-proxy','--https-proxy','--no-proxy','--user-agent')
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
    }
    if (-not $cmd) {
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
        _Safe_Pkg_Native_Fallback -Manager pnpm -PassArgs $passArgs
        return
    }

    try { $userFlags = @(_Safe_Pkg_User) } catch {
        Write-Host "✗ $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        return
    }

    $workspaceRoot = (Get-Location).Path
    $relPath = ""
    $d = (Get-Location).Path
    $root = [IO.Path]::GetPathRoot($d)
    # Split-Path returns "" above a Unix top-level dir (never "/"), so without
    # the $d check a project outside $HOME loops forever.
    while ($d -and $d -ne $HOME -and $d -ne $root) {
        if (Test-Path (Join-Path $d "pnpm-workspace.yaml")) {
            $workspaceRoot = $d
            $relPath = (Get-Location).Path.Substring($d.Length).TrimStart([char]'\', [char]'/')
            break
        }
        $d = Split-Path $d -Parent
    }

    $tmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }
    # Host-only, never mounted into a container: the post-fetch manifest
    # snapshots that copy-back reads from.
    $snapDir = New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }

    # tmpDir holds a copy of .npmrc (registry token); remove both dirs even if the
    # run is interrupted with Ctrl-C.
    try {

        Push-Location $workspaceRoot
        foreach ($f in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc')) {
            if (Test-Path $f) { Copy-Item $f $tmpDir.FullName }
        }
        $members = @()
        if (Test-Path "pnpm-workspace.yaml") {
            $members = @(Get-ChildItem -Recurse -Filter "package.json" |
                Where-Object { $_.FullName -notmatch [regex]::Escape("node_modules") -and
                               $_.DirectoryName -ne $workspaceRoot } |
                ForEach-Object {
                    $member = $_.DirectoryName.Substring($workspaceRoot.Length).TrimStart([char]'\', [char]'/')
                    $dest = Join-Path $tmpDir.FullName $member
                    New-Item -Type Directory -Force $dest | Out-Null
                    Copy-Item $_.FullName $dest
                    $member
                })
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
        $p1 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + @('-v',"$($tmpDir.FullName):/app",'-w',$workdir) +
            $tokenEnv + @('safe-pnpm:latest','pnpm') + $passArgs + @('--ignore-scripts') + $storeFlag
        & docker @p1
        $rc = $LASTEXITCODE

        # Known-malware check on the tree phase 1 resolved, before any package
        # code runs. A hit discards the sandbox: nothing is built or copied back.
        if ($rc -eq 0 -and -not (_Safe_Pkg_Malware_Scan (Join-Path $tmpDir.FullName 'pnpm-lock.yaml'))) { $rc = 1 }

        if ($rc -eq 0) {
            $manifests = @('package.json','pnpm-lock.yaml') + @($members | ForEach-Object { Join-Path $_ 'package.json' })
            _Safe_Pkg_Copy_Files -From $tmpDir.FullName -To $snapDir.FullName -RelPaths $manifests

            # CVE audit on the resolved tree, after the snapshot and before any
            # build script. A block discards the sandbox like a malware hit does.
            if (-not (_Safe_Pkg_Audit pnpm 'pnpm-lock.yaml' $snapDir.FullName $tmpDir.FullName)) { $rc = 1 }
        }

        if ($rc -eq 0) {
            # `pnpm fetch` only populates the store; there is nothing to build.
            if ($cmd -ne 'fetch') {
                # Strip registry credentials before any build script can run.
                _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.npmrc')
                _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmpDir.FullName '.yarnrc')

                $netFlag = @('--network','none')
                if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

                # Phase 2: build (no token, no .npmrc auth, network off by default).
                $p2 = @('run','--rm','--cap-drop','ALL') + (_Safe_Pkg_Hardening) + $userFlags + $netFlag +
                    @('-v',"$($tmpDir.FullName):/app",'-w',$workdir,'safe-pnpm:latest','pnpm','install','--offline','--trust-lockfile') + $storeFlag
                & docker @p2
                $rc = $LASTEXITCODE
            }

            # Only node_modules at the root and in pre-existing workspace members
            # come back, so phase 2 cannot plant node_modules elsewhere in the project.
            $moduleDirs = @('node_modules') + @($members | ForEach-Object { Join-Path $_ 'node_modules' })
            foreach ($rel in $moduleDirs) {
                if (-not (_Safe_Pkg_Copy_Modules -Base $tmpDir.FullName -Rel $rel -DestRoot $workspaceRoot)) { $rc = 1 }
            }
            _Safe_Pkg_Copy_Files -From $snapDir.FullName -To $workspaceRoot -RelPaths $manifests
        }

        $global:LASTEXITCODE = $rc
    } finally {
        Remove-Item -Recurse -Force $tmpDir.FullName, $snapDir.FullName -ErrorAction SilentlyContinue
    }
}
