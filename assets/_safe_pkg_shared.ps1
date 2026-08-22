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

    $sha = Join-Path $HOME ".safe-pnpm\scan-shai-hulud.js"
    if (Test-Path $sha) {
        Write-Host "→ Supply chain scan (Shai Hulud 2)..." -ForegroundColor Cyan
        node $sha (Get-Location).Path 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $ans = Read-Host "⚠️  Supply chain scan flagged issues. Continue anyway? [y/N]"
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
