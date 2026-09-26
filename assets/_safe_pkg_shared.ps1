# _safe_pkg_shared.ps1 — shared prescan for safe-pnpm, safe-npm, safe-yarn (PowerShell)
# Dot-sourced by each manager wrapper. Guard prevents double-loading.

if ($global:_SafePkgSharedLoaded) { return }
$global:_SafePkgSharedLoaded = $true

function _Safe_Pkg_Prescan {
    param([string]$Manager, [string]$Lockfile, [switch]$Socket)

    if (Test-Path $Lockfile) {
        Write-Host "→ $Manager audit..." -ForegroundColor Cyan
        $mgr = (Get-Command $Manager -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        switch ($Manager) {
            'pnpm' { & $mgr audit --audit-level moderate 2>$null | Out-Null }
            'npm'  { & $mgr audit --audit-level moderate 2>$null | Out-Null }
            'yarn' { & $mgr audit 2>$null | Out-Null }
        }
        if ($LASTEXITCODE -ne 0) {
            $ans = Read-Host "⚠️  $Manager audit found issues. Continue anyway? [y/N]"
            if ($ans -notmatch '^[Yy]') { return $false }
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
    $strict = ($env:SAFE_PNPM_SOCKET_STRICT -eq '1')
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
    Write-Host "⚠️  $reason Continuing without it." -ForegroundColor Yellow
    return $true
}

# Remove only credential-bearing lines from a copied .npmrc, leaving registry
# URLs, scopes and hoisting config intact. Used between the fetch and build
# phases so build-time lifecycle scripts never see a registry token.
function _Safe_Pkg_Strip_NpmrcAuth {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    (Get-Content $Path) |
        Where-Object { $_ -notmatch '(?i)(_authtoken|_auth|_password|username)\s*=' } |
        Set-Content $Path
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
    $dest = Join-Path $DestRoot $Rel
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -Type Directory -Force (Split-Path $dest -Parent) | Out-Null
    Copy-Item -LiteralPath $src $dest -Recurse
    return $true
}
