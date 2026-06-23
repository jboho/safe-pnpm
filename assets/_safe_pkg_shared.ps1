# _safe_pkg_shared.ps1 — shared prescan for safe-pnpm, safe-npm, safe-yarn (PowerShell)
# Dot-sourced by each manager wrapper. Guard prevents double-loading.

if ($global:_SafePkgSharedLoaded) { return }
$global:_SafePkgSharedLoaded = $true

function _Safe_Pkg_Prescan {
    param([string]$Manager, [string]$Lockfile)

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

    $socketCmd = Join-Path $HOME ".safe-pnpm\socket"
    if (Test-Path $socketCmd) {
        Write-Host "→ Socket behavioral scan..." -ForegroundColor Cyan
        & $socketCmd scan create . --no-spinner --no-banner 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $ans = Read-Host "⚠️  Socket flagged issues. Continue anyway? [y/N]"
            if ($ans -notmatch '^[Yy]') { return $false }
        }
    }

    return $true
}
