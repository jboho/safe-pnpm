# _safe_pkg_shared.ps1 — shared prescan for safe-pnpm, safe-npm, safe-yarn (PowerShell)
# Dot-sourced by each manager wrapper. Guard prevents double-loading.

if ($global:_SafePkgSharedLoaded) { return }
$global:_SafePkgSharedLoaded = $true

function _Safe_Pkg_Prescan {
    param([string]$Manager, [string]$Lockfile, [switch]$Socket)

    if (Test-Path $Lockfile) {
        Write-Host "→ $Manager audit..." -ForegroundColor Cyan
        $mgr = (Get-Command $Manager -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        # Output is kept and shown on failure: a non-zero exit means either
        # advisories or that the audit itself could not run (offline, registry
        # error), and the user needs the text to tell which.
        $auditOut = [IO.Path]::GetTempFileName()
        try {
            switch ($Manager) {
                'pnpm' { & $mgr audit --audit-level moderate *> $auditOut }
                'npm'  { & $mgr audit --audit-level moderate *> $auditOut }
                'yarn' { & $mgr audit *> $auditOut }
            }
            $auditRc = $LASTEXITCODE
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
        } finally {
            Remove-Item $auditOut -Force -ErrorAction SilentlyContinue
        }
    }

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

# Checks the lockfile the fetch phase resolved against OSV's malicious-package
# advisories. See _safe_pkg_shared.sh for the full rationale: findings always
# block, because a MAL- advisory marks that exact version as malware; failures
# (OSV unreachable, unreadable lockfile, scanner not installed) warn, and
# SAFE_PNPM_OSV_STRICT=1 makes them block too.
function _Safe_Pkg_Malware_Scan {
    param([string]$Lockfile)
    $scanner = Join-Path $HOME ".safe-pnpm\malware-scan.js"
    $verdict = 4
    $reason = "Malware scan not installed — run 'safe-pnpm setup'."

    if (Test-Path $scanner) {
        Write-Host "→ Malware scan (OSV)..." -ForegroundColor Cyan
        $reason = (& node $scanner $Lockfile 2>&1 | Out-String).Trim()
        $verdict = $LASTEXITCODE
    }

    if ($verdict -eq 0) {
        Write-Host "✓ $reason" -ForegroundColor Green
        return $true
    }
    if ($verdict -eq 3) {
        Write-Host "✗ $reason" -ForegroundColor Red
        Write-Host "✗ safe-pnpm: install blocked; nothing was built or copied back." -ForegroundColor Red
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

# Limits for both containers: no setuid escalation and a bounded process count
# (a fork bomb in a build script would otherwise take down the Docker VM).
# Memory is opt-in because legitimate builds vary widely in what they need.
function _Safe_Pkg_Hardening {
    $h = @('--security-opt','no-new-privileges','--pids-limit','1024')
    if ($env:SAFE_PNPM_MEMORY) { $h += @('--memory',$env:SAFE_PNPM_MEMORY) }
    return $h
}

# Both containers run as the invoking user, not root, so their files are owned
# by that user and an escape lands as an ordinary user. The image has no home
# dir for an arbitrary uid, so HOME points inside the sandbox mount. Windows has
# no uid to pass, so there they still run as root. `id` is resolved as an
# executable because a profile alias or function would shadow it, and a
# non-numeric result is refused: docker reads `--user :` as root.
function _Safe_Pkg_User {
    if ($IsWindows -or $env:OS -eq 'Windows_NT') { return @() }
    $idExe = (Get-Command id -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $u = "$(& $idExe -u)"; $g = "$(& $idExe -g)"
    if ($u -notmatch '^\d+$' -or $g -notmatch '^\d+$') {
        throw 'safe-pnpm: could not read your user id (id -u / id -g); refusing to run the install container as root.'
    }
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
