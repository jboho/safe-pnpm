# _safe_pkg_shared.ps1 — shared prescan for safe-pnpm, safe-npm, safe-yarn (PowerShell)
# Dot-sourced by each manager wrapper. It only defines functions, so it loads
# again on every dot-source: a profile re-run after safe-pnpm update must not
# pair the new wrappers with the old functions.

# Runs the manager's CVE audit on the tree phase 1 resolved, so a package
# passed to `add` is covered. Returns $false to block. See _safe_pkg_shared.sh
# for the full rationale. It runs on the host, so it audits a throwaway copy of
# the post-fetch snapshot plus the registry config (.npmrc from the sandbox, and
# .yarnrc without its yarn-path line), never the project. pnpm also skips the
# project's .pnpmfile.cjs, which would otherwise run on the host.
function _Safe_Pkg_Audit {
    param([string]$Manager, [string]$Lockfile, [string]$SnapDir, [string]$TmpDir)
    if (-not (Test-Path -LiteralPath (Join-Path $SnapDir $Lockfile) -PathType Leaf)) { return $true }

    $mgr = (Get-Command $Manager -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $auditDir = New-Item -Type Directory (Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName()))
    $auditOut = [IO.Path]::GetTempFileName()
    try {
        Copy-Item -Recurse -Path (Join-Path $SnapDir '*') -Destination $auditDir.FullName
        $npmrc = Join-Path $TmpDir '.npmrc'
        if (Test-Path -LiteralPath $npmrc -PathType Leaf) { Copy-Item -LiteralPath $npmrc (Join-Path $auditDir.FullName '.npmrc') }
        $yarnrc = Join-Path $TmpDir '.yarnrc'
        if (Test-Path -LiteralPath $yarnrc -PathType Leaf) {
            Get-Content -LiteralPath $yarnrc | Where-Object { $_ -notmatch '^\s*"?yarn-path' } |
                Set-Content (Join-Path $auditDir.FullName '.yarnrc')
        }

        Write-Host "→ $Manager audit..." -ForegroundColor Cyan
        Push-Location $auditDir.FullName
        try {
            switch ($Manager) {
                'pnpm' { & $mgr audit --audit-level moderate --config.ignore-pnpmfile=true *> $auditOut }
                'npm'  { & $mgr audit --audit-level moderate *> $auditOut }
                'yarn' { & $mgr audit *> $auditOut }
            }
            $auditRc = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($auditRc -ne 0) {
            Get-Content $auditOut -Tail 40 | ForEach-Object { [Console]::Error.WriteLine($_) }
            if ($env:SAFE_PNPM_STRICT -eq '1') {
                Write-Host "✗ $Manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." -ForegroundColor Red
                return $false
            }
            if (-not [Console]::IsInputRedirected) {
                $ans = Read-Host "⚠️  $Manager audit failed or found issues. Continue anyway? [y/N]"
                if ($ans -notmatch '^[Yy]') { return $false }
            } else {
                Write-Host "⚠️  $Manager audit failed or found issues — continuing in non-interactive mode." -ForegroundColor Yellow
            }
        }
        return $true
    } finally {
        Remove-Item -Recurse -Force $auditDir.FullName, $auditOut -ErrorAction SilentlyContinue
    }
}

# True when the args ask for a global install. See _safe_pkg_is_global in
# _safe_pkg_shared.sh for why the wrapper refuses these.
function _Safe_Pkg_Is_Global {
    param([string[]]$PassArgs)
    $prev = ''
    # yarn v1 spells it as a subcommand: yarn global add|remove|upgrade
    $words = @($PassArgs | Where-Object { $_ -notlike '-*' })
    if ($words.Count -ge 2 -and $words[0] -eq 'global' -and $words[1] -in @('add','remove','upgrade')) { return $true }
    foreach ($a in $PassArgs) {
        if ($a -eq '--') { return $false }
        if ($a -in @('--global','--global=true','--global=1','--location=global')) { return $true }
        if ($a -notlike '--*' -and $a -clike '-*g*') { return $true }
        if ($prev -eq '--location' -and $a -eq 'global') { return $true }
        $prev = $a
    }
    return $false
}

# Returns the first flag that points the package manager at another
# directory, or $null. See _safe_pkg_dir_flag in _safe_pkg_shared.sh for why
# the wrapper refuses these and which spellings each manager accepts. The
# comparisons are case-sensitive, like the managers' own parsers.
function _Safe_Pkg_Dir_Flag {
    param([string]$Manager, [string[]]$PassArgs)
    $long = @{
        npm  = @('prefi','prefix')
        pnpm = @('dir','prefi','prefix','shrinkwrap-directory','lockfile-d','lockfile-di','lockfile-dir','lockfile-dire','lockfile-direc','lockfile-direct','lockfile-directo','lockfile-director','lockfile-directory')
    }
    foreach ($a in $PassArgs) {
        if ($a -ceq '--') { return $null }
        if ($a -notlike '-*') { continue }
        $name = ([string]$a -split '=', 2)[0]
        if ($Manager -eq 'yarn') {
            if ($name -ceq '--cwd') { return $a }
            continue
        }
        $name = $name -replace '^-+', ''
        if ($long[$Manager] -ccontains $name) { return $a }
        if ($Manager -eq 'pnpm' -and $name -clike 'config.*') {
            $key = $name.Substring(7).ToLowerInvariant() -replace '[-_]',''
            if ($key -in @('dir','prefix','lockfiledir')) { return $a }
            continue
        }
        if ($name -cmatch '^[A-Za-z]*C[A-Za-z]*$') { return $a }
    }
    return $null
}

# Quotes args for the bypass command the refusals print, so it can be pasted
# back as it was typed.
function _Safe_Pkg_Quote_Args {
    param([string[]]$PassArgs)
    @($PassArgs | ForEach-Object {
        if ($_ -cmatch '^[A-Za-z0-9_./:=+-][A-Za-z0-9_./:=@+-]*$') { $_ } else { "'" + ($_ -replace "'", "''") + "'" }
    }) -join ' '
}

# Returns the file and key of the first setting in Dir's .npmrc or
# pnpm-workspace.yaml that moves pnpm's lockfile, or $null. See
# _safe_pkg_lockfile_dir_setting in _safe_pkg_shared.sh.
function _Safe_Pkg_Lockfile_Dir_Setting {
    param([string]$Dir)
    $checks = @(
        @('.npmrc', '^\s*["'']?(lockfile-dir|lockfile-directory|shrinkwrap-directory)["'']?\s*='),
        @('pnpm-workspace.yaml', '^[^#]*(lockfile-?dir)["'']?\s*:')
    )
    foreach ($c in $checks) {
        $path = Join-Path $Dir $c[0]
        if (-not (Test-Path -LiteralPath $path)) { continue }
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line -match $c[1]) { return @($c[0], $Matches[1]) }
        }
    }
    return $null
}

function _Safe_Pkg_Prescan {
    param([string]$Manager, [string]$Lockfile, [switch]$Socket)

    # Socket is opt-in: enable globally with SAFE_PNPM_ENABLE_SOCKET=1 or
    # per-invocation with `--socket`.
    $socketEnabled = ($env:SAFE_PNPM_ENABLE_SOCKET -eq '1') -or $Socket
    if ($socketEnabled) {
        if (-not (_Safe_Pkg_Socket_Scan)) { return $false }
    }

    return $true
}

# Applies safe-pnpm's Socket failure semantics. See _safe_pkg_shared.sh for the
# full rationale; the three outcomes are pass, findings (scan ran, unhealthy
# report) and failure (scan could not run). Findings prompt; failures only warn,
# because a scan that never ran is not evidence of a problem.
# SAFE_PNPM_SOCKET_STRICT=1 makes both block.
function _Safe_Pkg_Socket_Scan {
    $strict = ($env:SAFE_PNPM_SOCKET_STRICT -eq '1') -or ($env:SAFE_PNPM_STRICT -eq '1')
    $socketCmd = Join-Path $HOME ".safe-pnpm\socket"
    $classifier = Join-Path $HOME ".safe-pnpm\socket-classify.js"

    if (-not (Test-Path $socketCmd) -or -not (Test-Path $classifier)) {
        if ($strict) {
            Write-Host "✗ Socket scan requested but not installed — run 'safe-pnpm setup' (SAFE_PNPM_SOCKET_STRICT=1)." -ForegroundColor Red
            return $false
        }
        Write-Host "⚠️  Socket scan requested but not installed — skipping. Run 'safe-pnpm setup'." -ForegroundColor Yellow
        return $true
    }

    Write-Host "→ Socket behavioral scan..." -ForegroundColor Cyan

    $out = New-TemporaryFile
    # --report waits for the scan to finish and applies the org policy; without
    # it `scan create` can never surface findings.
    & $socketCmd scan create . --report --json --no-spinner --no-banner 2>$null |
        Out-File -FilePath $out.FullName -Encoding utf8
    $rc = $LASTEXITCODE

    $reason = (& node $classifier $out.FullName $rc 2>&1 | Out-String).Trim()
    $verdict = $LASTEXITCODE
    Remove-Item $out.FullName -Force -ErrorAction SilentlyContinue

    if ($verdict -eq 0) { return $true }

    if ($strict) {
        Write-Host "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." -ForegroundColor Red
        return $false
    }

    if ($verdict -eq 3) {
        $ans = Read-Host "⚠️  $reason Continue anyway? [y/N]"
        if ($ans -notmatch '^[Yy]') { return $false }
        return $true
    }

    Write-Host "⚠️  $reason Continuing without Socket results." -ForegroundColor Yellow
    return $true
}

# Global flags that take a separate value, per manager, so the finders can skip
# the value instead of reading it as a command. npx takes npm's list. Mirrors
# _safe_pkg_valueflags in _safe_pkg_shared.sh.
function _Safe_Pkg_Valueflags {
    param([string]$Manager)
    $lists = @{
        pnpm = @('-C','--dir','-F','--filter','--filter-prod','--workspace-dir','--reporter','--loglevel','--config','--store-dir','--state-dir','--registry','--lockfile-dir','--network-concurrency','--fetch-timeout','--workspace-concurrency','--test-pattern','--changed-files-ignore-pattern','--http-proxy','--https-proxy','--no-proxy','--user-agent')
        npm = @('--prefix','-w','--workspace','--registry','--cache','--userconfig','--globalconfig','--loglevel','--otp','--scope','--omit','--include','--install-strategy','--tag','--before','--audit-level','--fetch-retries','--lockfile-version','--min-release-age','--cpu','--os','--libc','--script-shell','--node-options','--maxsockets','--location')
        yarn = @('--cwd','--registry','--modules-folder','--cache-folder','--preferred-cache-folder','--global-folder','--link-folder','--network-concurrency','--network-timeout','--proxy','--https-proxy','--mutex','--use-yarnrc','--cafile','--otp')
    }
    if ($Manager -eq 'npx') { $Manager = 'npm' }
    if ($Manager -eq 'pnpx') { $Manager = 'pnpm' }
    return $lists[$Manager]
}

# For the commands that download a package and run it (npx, pnpx, npm exec,
# npm init|create, pnpm dlx|create, yarn dlx|create) outputs the package specs
# that will be fetched; for any other command, nothing. A port of
# _safe_pkg_runner_specs in _safe_pkg_shared.sh, which has the rules: every
# reading of an ambiguous parse is scanned.
function _Safe_Pkg_Runner_Specs {
    param([string]$Manager, [string[]]$PassArgs)
    if ($Manager -eq 'npx') { return _Safe_Pkg_Runner_Tail -Manager npm -Mode exec -PassArgs $PassArgs }
    if ($Manager -eq 'pnpx') { return _Safe_Pkg_Runner_Tail -Manager pnpm -Mode exec -PassArgs $PassArgs }
    $valueFlags = @(_Safe_Pkg_Valueflags $Manager)
    $exec = @('npm:exec','npm:exe','npm:x','pnpm:dlx','yarn:dlx')
    $create = @('npm:init','npm:ini','npm:inn','npm:inni','npm:innit','npm:cr','npm:cre','npm:crea','npm:creat','npm:create','pnpm:create','yarn:create')
    $pkgs = [System.Collections.Generic.List[string]]::new()
    # skip: '', 'value' (drop the next word) or 'pkg' (the next word is a package).
    $skip = ''
    $maybe = $false
    $dd = $false
    $i = 0
    while ($i -lt $PassArgs.Count) {
        $a = [string]$PassArgs[$i]; $i++
        if (-not $dd) {
            if ($skip) {
                if ($a -like '-*') { $skip = ''; $maybe = $true; continue }
                if ($skip -eq 'pkg') { $pkgs.Add($a) }
                $skip = ''
                continue
            }
            if ($a -eq '--') {
                if ($Manager -eq 'yarn') { break }
                $dd = $true; $maybe = $false; continue
            }
            if ($a -clike '--package=*') {
                $maybe = $false
                if ($Manager -ne 'yarn') { $pkgs.Add($a.Substring($a.IndexOf('=') + 1)) }
                continue
            }
            if ($a -ceq '--package') {
                if ($Manager -eq 'yarn') { $maybe = $true } else { $maybe = $false; $skip = 'pkg' }
                continue
            }
            if ($a -like '-*=*') { $maybe = $false; continue }
            if ($a -like '-*') {
                $maybe = $true
                if (($valueFlags -ccontains $a) -or [bool](_Safe_Pkg_Dir_Flag -Manager $Manager -PassArgs @($a))) { $maybe = $false; $skip = 'value' }
                continue
            }
        }
        $key = "${Manager}:$a"
        $mode = if ($exec -contains $key) { 'exec' } elseif ($create -contains $key) { 'create' } else { '' }
        if ($mode) {
            $rest = if ($i -lt $PassArgs.Count) { @($PassArgs[$i..($PassArgs.Count - 1)]) } else { @() }
            _Safe_Pkg_Runner_Tail -Manager $Manager -Mode $mode -Pkgs @($pkgs) -DashDash:$dd -PassArgs $rest
        }
        # A word that may be a flag's value: the next word may be the command.
        if ($maybe -and -not $dd) { $maybe = $false; continue }
        break
    }
}

# The spec finder for one reading of the command word; see
# _Safe_Pkg_Runner_Specs. Pkgs are the --package values read before the
# command word; -DashDash means a -- came before it, so no word is a flag.
function _Safe_Pkg_Runner_Tail {
    param([string]$Manager, [string]$Mode, [string[]]$Pkgs, [switch]$DashDash, [string[]]$PassArgs)
    $valueFlags = @(_Safe_Pkg_Valueflags $Manager)
    $bools = @('-y','--yes','-n','--no','--no-install','--ignore-existing','-s','--shell-mode','--silent','-q','--quiet','--verbose','--json','--offline','--prefer-offline','-ws','--workspaces','--no-workspaces','--include-workspace-root','--no-color','--color','--no-fund','--no-audit')
    $pkgList = [System.Collections.Generic.List[string]]::new()
    foreach ($p in @($Pkgs)) { if ($null -ne $p) { $pkgList.Add($p) } }
    $pos = [System.Collections.Generic.List[string]]::new()
    $dd = [bool]$DashDash
    $skip = ''
    $maybe = $false
    $found = $false
    $npmLike = $Manager -in @('npm','pnpm')
    foreach ($a in @($PassArgs)) {
        $a = [string]$a
        if (-not $dd) {
            if ($skip) {
                if ($a -like '-*') { $skip = ''; $maybe = $true; continue }
                if ($skip -eq 'pkg') { $pkgList.Add($a) }
                $skip = ''
                continue
            }
            if ($a -eq '--') {
                $dd = $true
                if ($found) { break }
                $maybe = $false; continue
            }
            if ($npmLike -and ($a -ceq '-p' -or $a -ceq '--package')) { $maybe = $false; $skip = 'pkg'; continue }
            if ($npmLike -and ($a -clike '--package=*' -or $a -clike '-p=*')) { $maybe = $false; $pkgList.Add($a.Substring($a.IndexOf('=') + 1)); continue }
            if ($Manager -eq 'npm' -and ($a -ceq '-c' -or $a -ceq '--call')) { $maybe = $false; $skip = 'value'; continue }
            if (($a -like '-*=*') -or ($Manager -eq 'pnpm' -and $a -ceq '-c') -or ($bools -ccontains $a)) { $maybe = $false; continue }
            if ($a -like '-*') {
                $maybe = $true
                if ($valueFlags -ccontains $a) { $maybe = $false; $skip = 'value' }
                continue
            }
        }
        # npm reads flags after the command name too; only --package matters there.
        if ($found) { continue }
        $pos.Add($a)
        if ($maybe -and -not $dd) { $maybe = $false; continue }
        $found = $true
        if ($Manager -eq 'npm' -and -not $dd) { continue }
        break
    }
    if ($Mode -eq 'create') {
        $pkgList
        foreach ($line in $pos) {
            if (-not $line) { continue }
            if ($line -like '@*/*') {
                $slash = $line.IndexOf('/')
                $scope = $line.Substring(0, $slash + 1)
                $rest = $line.Substring($slash + 1)
            } elseif ($line -like '@*') {
                # `create @scope[@version]` runs @scope/create
                $rest = $line.Substring(1)
                $at = $rest.IndexOf('@')
                if ($at -lt 0) { "@$rest/create" } else { "@$($rest.Substring(0, $at))/create$($rest.Substring($at))" }
                continue
            } else {
                $scope = ''
                $rest = $line
            }
            "${scope}create-$rest"
            if ($rest -clike 'create-*') { $line }
        }
        return
    }
    if ($pkgList.Count) { $pkgList } else { $pos }
}

# Runs before a download-and-run command: $true at once for any other command,
# otherwise the OSV check on the packages it would fetch (malware-scan.js
# --specs), $false on a MAL- advisory. See _safe_pkg_runner_check in
# _safe_pkg_shared.sh.
function _Safe_Pkg_Runner_Check {
    param([string]$Manager, [string[]]$PassArgs)
    # Windows PowerShell, and pwsh for .cmd targets like npx.cmd, drop empty
    # arguments to a native command, while pwsh elsewhere passes them on. Check
    # what either reading of `npx "" mal-pkg` would fetch.
    $nonEmpty = @($PassArgs | Where-Object { $_ })
    $specs = @(@(_Safe_Pkg_Runner_Specs -Manager $Manager -PassArgs $PassArgs) +
        @(_Safe_Pkg_Runner_Specs -Manager $Manager -PassArgs $nonEmpty) | Where-Object { $_ } | Select-Object -Unique)
    if ($specs.Count -eq 0) { return $true }
    return (_Safe_Pkg_Malware_Scan -Specs $specs)
}

# Checks the lockfile the fetch phase resolved, or with -Specs the packages a
# download-and-run command would fetch, against OSV's malicious-package
# advisories. See _safe_pkg_shared.sh for the full rationale: findings always
# block, because a MAL- advisory marks that exact version as malware; failures
# (OSV unreachable, unreadable lockfile, scanner not installed) warn, and
# SAFE_PNPM_OSV_STRICT=1 makes them block too.
function _Safe_Pkg_Malware_Scan {
    param([string]$Lockfile, [string[]]$Specs)
    $scanArgs = if ($Specs) { @('--specs') + $Specs } else { @($Lockfile) }
    $scanner = Join-Path $HOME ".safe-pnpm\malware-scan.js"
    $verdict = 4
    $reason = "Malware scan not installed — run 'safe-pnpm setup'."

    if (Test-Path $scanner) {
        Write-Host "→ Malware scan (OSV)..." -ForegroundColor Cyan
        # A missing `node` leaves $LASTEXITCODE at whatever an earlier native
        # command set (often 0), which would read as a pass.
        if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
            $global:LASTEXITCODE = 4
            $reason = (& node $scanner @scanArgs 2>&1 | Out-String).Trim()
            $verdict = $LASTEXITCODE
        } else {
            $reason = "node not found; malware scan cannot run."
        }
    }

    if ($verdict -eq 0) {
        Write-Host "✓ $reason" -ForegroundColor Green
        return $true
    }
    if ($verdict -eq 3) {
        Write-Host "✗ $reason" -ForegroundColor Red
        if ($Specs) {
            Write-Host "✗ safe-pnpm: not running it; no package code was executed." -ForegroundColor Red
        } else {
            Write-Host "✗ safe-pnpm: install blocked; nothing was built or copied back." -ForegroundColor Red
        }
        return $false
    }
    if ($env:SAFE_PNPM_OSV_STRICT -eq '1') {
        Write-Host "✗ $reason Blocking (SAFE_PNPM_OSV_STRICT=1)." -ForegroundColor Red
        return $false
    }
    if ($env:SAFE_PNPM_STRICT -eq '1') {
        Write-Host "✗ $reason Blocking (SAFE_PNPM_STRICT=1)." -ForegroundColor Red
        return $false
    }
    Write-Host "⚠️  $reason Continuing without it." -ForegroundColor Yellow
    return $true
}

# Remove only credential-bearing lines from a copied .npmrc/.yarnrc, leaving
# registry URLs, scopes and hoisting config intact. Used between the fetch and
# build phases so build-time lifecycle scripts never see a registry token.
# .yarnrc (v1) writes `_authToken "x"` with no `=`; .yarnrc.yml uses
# npmAuthToken/npmAuthIdent keys with `:`.
function _Safe_Pkg_Strip_NpmrcAuth {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $kept = @(Get-Content $Path |
        Where-Object { $_ -notmatch '(?i)(_authtoken|_auth|_password|username|npmauthtoken|npmauthident)\s*[=:"\s]' })
    # Set-Content with an empty pipeline leaves the file untouched, which would
    # keep every credential when nothing else is in the file.
    [IO.File]::WriteAllLines((Resolve-Path -LiteralPath $Path).Path, [string[]]$kept)
}

# See _safe_pkg_host_platform in _safe_pkg_shared.sh. Native optional
# dependencies (rollup, esbuild, ...) come as one package per platform and the
# container picks the Linux one, so tools run on a Windows or macOS host fail.
# Fetches the host's build too, so it is malware-scanned and audited like the
# rest. Linux hosts match the container and change nothing.
#   pnpm: supportedArchitectures through pnpm-arch.js, in the sandbox copy of
#         pnpm-workspace.yaml, or of package.json for a project pinned to pnpm
#         10 or earlier (the original goes to -Saved for _Safe_Pkg_Pnpm_Arch_Restore);
#         a project's own setting wins.
#   yarn: returns --ignore-platform (every platform's build).
#   npm:  unchanged (see the README).
# Returns extra package-manager flags; may edit TmpDir. -Os and -Cpu exist for
# tests; they default to the host's.
function _Safe_Pkg_Host_Platform {
    param([string]$Manager, [string]$TmpDir, [string]$Saved, [string]$Os, [string]$Cpu)
    $P = [Runtime.InteropServices.OSPlatform]
    if (-not $Os) {
        if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::Windows)) { $Os = 'win32' }
        elseif ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::OSX)) { $Os = 'darwin' }
    }
    if (-not $Cpu) {
        $Cpu = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
            'X64' { 'x64' } 'Arm64' { 'arm64' } default { '' }
        }
    }
    if ($Os -notin @('win32','darwin') -or -not $Cpu) { return @() }
    switch ($Manager) {
        'pnpm' {
            $helper = Join-Path $HOME '.safe-pnpm/pnpm-arch.js'
            if (-not (Test-Path -LiteralPath $helper)) {
                Write-Host "⚠️  safe-pnpm: pnpm-arch.js missing, so native packages for $Os are not fetched (run: safe-pnpm update)." -ForegroundColor Yellow
                return @()
            }
            # A missing node would leave $LASTEXITCODE at an earlier command's value.
            $global:LASTEXITCODE = 1
            if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
                # Out-Host keeps node's output out of the returned flags.
                & node $helper apply $TmpDir $Os $Cpu $Saved 2>&1 | Out-Host
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Host "⚠️  safe-pnpm: could not add $Os to pnpm's supportedArchitectures, so native packages for $Os are not fetched." -ForegroundColor Yellow
            }
            return @()
        }
        'yarn' { return @('--ignore-platform') }
    }
    return @()
}

# See _safe_pkg_pnpm_arch_restore in _safe_pkg_shared.sh. Returns $false when
# the snapshot must not be copied back.
function _Safe_Pkg_Pnpm_Arch_Restore {
    param([string]$File, [string]$Saved)
    if (-not (Test-Path -LiteralPath $Saved)) { return $true }
    $global:LASTEXITCODE = 1
    if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
        & node (Join-Path $HOME '.safe-pnpm/pnpm-arch.js') restore $File $Saved 2>&1 | Out-Host
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ safe-pnpm: could not take safe-pnpm's supportedArchitectures out of package.json; nothing copied back." -ForegroundColor Red
        return $false
    }
    return $true
}

# npm cannot fetch several platforms at once (--os/--cpu replace the container's
# platform, and esbuild's install script then fails in the build container), so
# this adds the host's optional packages next to the Linux ones, by name and
# version from the already-scanned lockfile. See _safe_pkg_npm_host_builds in
# _safe_pkg_shared.sh. Needs the token, so run it before the credentials are
# stripped. Returns $false when the install step fails. -Os and -Cpu are for tests.
function _Safe_Pkg_Npm_Host_Builds {
    param([string]$TmpDir, [string[]]$Hardening, [string[]]$UserFlags, [string[]]$TokenEnv, [string]$Os, [string]$Cpu)
    $P = [Runtime.InteropServices.OSPlatform]
    if (-not $Os) {
        if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::Windows)) { $Os = 'win32' }
        elseif ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::OSX)) { $Os = 'darwin' }
    }
    if (-not $Cpu) {
        $Cpu = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
            'X64' { 'x64' } 'Arm64' { 'arm64' } default { '' }
        }
    }
    if ($Os -notin @('win32','darwin') -or -not $Cpu) { return $true }
    $specs = Join-Path $HOME '.safe-pnpm/host-specs.js'
    # .cjs so a "type": "module" package.json in the sandbox doesn't make node
    # load it as an ES module (see _safe_pkg_npm_host_builds in _safe_pkg_shared.sh).
    $dest = Join-Path $TmpDir '.safe-host-specs.cjs'
    try { Copy-Item -LiteralPath $specs -Destination $dest -ErrorAction Stop } catch {
        Write-Host "⚠️  safe-pnpm: host-specs.js missing, so native packages for $Os are not installed (run: safe-pnpm update)." -ForegroundColor Yellow
        return $true
    }
    $script = 'specs=$(node /app/.safe-host-specs.cjs $1 $2) || exit 1; [ -z "$specs" ] || npm install --no-save --ignore-scripts --force --cache /app/.safe-store -- $specs'
    $a = @('run','--rm','--cap-drop','ALL') + $Hardening + $UserFlags + @('-v',"${TmpDir}:/app",'-w','/app') + $TokenEnv +
        @('safe-pnpm:latest','sh','-c',$script,'sh',$Os,$Cpu)
    # Out-Host keeps docker's output out of the return value, which must be one bool.
    & docker @a | Out-Host
    $ok = ($LASTEXITCODE -eq 0)
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    return $ok
}

# Limits for both containers: no setuid escalation and a bounded process count
# (a fork bomb in a build script would otherwise take down the Docker VM).
# Memory is opt-in because legitimate builds vary widely in what they need.
function _Safe_Pkg_Hardening {
    $h = @('--security-opt','no-new-privileges','--pids-limit','1024')
    if ($env:SAFE_PNPM_MEMORY) { $h += @('--memory',$env:SAFE_PNPM_MEMORY) }
    return $h
}

# See _safe_pkg_docker_rootless in _safe_pkg_shared.sh. $LASTEXITCODE separates
# a failed query from an empty answer, and a docker that cannot be run counts
# as not rootless. -clike and -ceq, because -like and -eq ignore case and the
# daemon's answers are exact.
function _Safe_Pkg_Docker_Rootless {
    try {
        $opts = & docker info --format '{{json .SecurityOptions}}' 2>$null
        if ($LASTEXITCODE -eq 0) { return ("$opts" -clike '*"name=rootless"*') }
        $podman = & docker info --format '{{.Host.Security.Rootless}}' 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        return ("$podman".Trim() -ceq 'true')
    } catch {
        return $false
    }
}

# Both containers run as the invoking user, not root (except under rootless
# Docker or Podman, see _Safe_Pkg_Docker_Rootless), so their files are owned by
# that user and an escape lands as an ordinary user. The image has no home
# dir for an arbitrary uid, so HOME points inside the sandbox mount. Windows has
# no uid to pass, so there they still run as root. `id` is resolved as an
# executable because a profile alias or function would shadow it, and a
# non-numeric result is refused: docker reads `--user :` as root.
function _Safe_Pkg_User {
    if ($IsWindows -or $env:OS -eq 'Windows_NT') { return @() }
    $idExe = (Get-Command id -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if ($idExe) { $u = "$(& $idExe -u)"; $g = "$(& $idExe -g)" } else { $u = ''; $g = '' }
    if ($u -notmatch '^\d+$' -or $g -notmatch '^\d+$') {
        throw 'safe-pnpm: could not read your user id (id -u / id -g); refusing to run the install container as root.'
    }
    if (_Safe_Pkg_Docker_Rootless) { return @() }
    return @('--user', "${u}:${g}", '-e', 'HOME=/app/.safe-home')
}

# Docker is not running. Non-interactive (CI, scripts): fail closed, because
# silently running native would execute untrusted lifecycle scripts on the host.
# Interactive: ask. Mirrors the docker-down branch of _safe_pkg_run in
# _safe_pkg_shared.sh.
function _Safe_Pkg_Native_Fallback {
    param([string]$Manager, [object[]]$PassArgs)
    $exe = (Get-Command $Manager -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if ([Console]::IsInputRedirected) {
        if ($env:SAFE_PNPM_ALLOW_NATIVE_FALLBACK -eq '1') {
            Write-Host "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native $Manager." -ForegroundColor Yellow
            & $exe @PassArgs
            return
        }
        Write-Host "✗ safe-pnpm: Docker not running and no TTY — refusing native $Manager (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." -ForegroundColor Red
        $global:LASTEXITCODE = 1
        return
    }
    $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native $Manager? [y/N]"
    if ($ans -match '^[Yy]') {
        & $exe @PassArgs
    } else {
        $global:LASTEXITCODE = 1
    }
}

# Copies each relative file path that exists under From to the same path under
# To. Used to snapshot manifests and lockfile after phase 1 and to restore them
# after phase 2: phase 1 runs no package code, so the snapshot holds only the
# package manager's own edits, while phase 2 build scripts can rewrite anything
# under /app. A rewritten package.json script or lockfile URL would run natively
# on the next host command, so copy-back never reads manifests from the sandbox.
function _Safe_Pkg_Copy_Files {
    param([string]$From, [string]$To, [string[]]$RelPaths)
    foreach ($rel in $RelPaths) {
        $src = Join-Path $From $rel
        if (Test-Path -LiteralPath $src -PathType Leaf) {
            $dest = Join-Path $To $rel
            New-Item -Type Directory -Force (Split-Path $dest -Parent) | Out-Null
            Copy-Item -LiteralPath $src $dest
        }
    }
}

# Copies <Base>/<Rel> (a node_modules) to <DestRoot>/<Rel>. The sandbox tree is
# untrusted after phase 2, so every path component under Base must be a plain
# directory: a node_modules, or a member dir, swapped for a link could otherwise
# pull in files from anywhere the link points. Returns $false when it refuses.
function _Safe_Pkg_Copy_Modules {
    param([string]$Base, [string]$Rel, [string]$DestRoot)
    $src = Join-Path $Base $Rel
    if (-not (Get-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue)) { return $true }
    $p = $Base
    foreach ($part in ($Rel -split '[\\/]')) {
        $p = Join-Path $p $part
        $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if (-not $i -or -not $i.PSIsContainer -or $i.LinkType -or
            ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Host "✗ safe-pnpm: sandbox $Rel is not a plain directory; not copied back." -ForegroundColor Red
            return $false
        }
    }
    if (-not (_Safe_Pkg_Links_Ok -Base $Base -Rel $Rel)) { return $false }
    $dest = Join-Path $DestRoot $Rel
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -Type Directory -Force (Split-Path $dest -Parent) | Out-Null
    try {
        _Safe_Pkg_Copy_Tree -From $src -To $dest
    } catch {
        Write-Host "✗ safe-pnpm: copying $Rel back failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    return $true
}

# Fails closed, like _safe_pkg_links_ok in _safe_pkg_shared.sh: a missing
# checker or an unreadable tree refuses copy-back. See link-check.js.
function _Safe_Pkg_Links_Ok {
    param([string]$Base, [string]$Rel)
    $checker = Join-Path $HOME ".safe-pnpm\link-check.js"
    if (-not (Test-Path -LiteralPath $checker)) {
        Write-Host "✗ safe-pnpm: link check not installed — run 'safe-pnpm update'. $Rel not copied back." -ForegroundColor Red
        return $false
    }
    # A missing `node` leaves $LASTEXITCODE at whatever an earlier native
    # command set (often 0), which would read as a pass.
    if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
        Write-Host "✗ safe-pnpm: node not found; link check cannot run. $Rel not copied back." -ForegroundColor Red
        return $false
    }
    $global:LASTEXITCODE = 1
    $out = (& node $checker $Base $Rel 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ safe-pnpm: $Rel not copied back. $out" -ForegroundColor Red
        return $false
    }
    return $true
}

# Copy-Item -Recurse follows symlinks (PowerShell 7.4, probed), turning each
# link into a real copy of its target, and one aimed outside the tree into a
# copy of host files. pnpm's layout is built from links, so recreate them as
# links; _Safe_Pkg_Links_Ok has already vetted every target.
function _Safe_Pkg_Copy_Tree {
    param([string]$From, [string]$To)
    New-Item -Type Directory -Force $To -ErrorAction Stop | Out-Null
    foreach ($i in (Get-ChildItem -LiteralPath $From -Force -ErrorAction Stop)) {
        $d = Join-Path $To $i.Name
        if ($i.LinkType -eq 'SymbolicLink' -or $i.LinkType -eq 'Junction') {
            New-Item -ItemType SymbolicLink -Path $d -Target ([string]@($i.Target)[0]) -ErrorAction Stop | Out-Null
        } elseif ($i.PSIsContainer) {
            _Safe_Pkg_Copy_Tree -From $i.FullName -To $d
        } else {
            Copy-Item -LiteralPath $i.FullName $d -ErrorAction Stop
        }
    }
}
