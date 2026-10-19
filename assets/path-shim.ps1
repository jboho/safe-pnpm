# safe-pnpm PATH shim for Windows. ~/.safe-pnpm/bin holds NAME.cmd (what
# cmd.exe, cross-spawn and Node's spawn with shell: true find) and NAME.ps1
# (what PowerShell finds) for pnpm, pnpx, npm, npx and yarn; each runs this
# script in its own pwsh process with the name as the first argument. It
# dot-sources the same wrapper as the PowerShell profile and calls the same
# function, so programs that start a package manager themselves get the same
# checks. _Safe_Pkg_Native_Exe skips the shim directory when it looks up the
# real binary. See path-shim.sh for the macOS and Linux version.

# The wrappers report through Write-Host, which a pwsh process writes to
# stdout. Programs that start npx read stdout as the tool's own output (MCP
# servers speak JSON-RPC there), so the messages go to stderr instead.
function global:Write-Host {
    param(
        [Parameter(Position = 0, ValueFromRemainingArguments = $true)][object[]]$Object,
        [object]$ForegroundColor,
        [object]$BackgroundColor,
        [switch]$NoNewline,
        [object]$Separator = ' '
    )
    $text = @($Object | ForEach-Object { "$_" }) -join $Separator
    if ($NoNewline) { [Console]::Error.Write($text) } else { [Console]::Error.WriteLine($text) }
}

$shimDir = Join-Path (Join-Path $HOME '.safe-pnpm') 'bin'

# Each level of nesting (a package script that runs pnpm again) passes through
# here once. A chain this deep is a loop, for example a wrapper that finds
# this shim as the real binary; stop it instead of starting processes forever.
$depth = 1 + [int]$env:_SAFE_PKG_SHIM_DEPTH
$env:_SAFE_PKG_SHIM_DEPTH = "$depth"
if ($depth -gt 32) {
    Write-Host "✗ safe-pnpm: the PATH shim was entered $depth times in a row, so it stopped. Run ``safe-pnpm update``, or take $shimDir off PATH."
    exit 1
}

$name = "$($args[0])".ToLower()
# An if expression would unroll a one-element array into a string, which
# splatting then passes one character at a time.
[object[]]$rest = @()
if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
$wrapper = switch ($name) {
    { $_ -in 'pnpm', 'pnpx' } { 'pnpm' }
    { $_ -in 'npm', 'npx' } { 'npm' }
    'yarn' { 'yarn' }
    default {
        Write-Host "✗ safe-pnpm: unknown shim name $name; expected pnpm, pnpx, npm, npx or yarn."
        exit 2
    }
}

$file = Join-Path (Join-Path $HOME '.safe-pnpm') "$wrapper-wrapper.ps1"
$loaded = $false
if (Test-Path -LiteralPath $file -PathType Leaf) {
    try { . $file; $loaded = $true } catch { $loaded = $false }
}
if (-not $loaded -or -not (Get-Command $name -CommandType Function -ErrorAction SilentlyContinue)) {
    Write-Host "✗ safe-pnpm: cannot load $file, so $name was not run. Run ``safe-pnpm update``, or take $shimDir off PATH."
    exit 1
}
# Wrappers older than the shims look up the real binary with Get-Command,
# which finds this shim again. Only run with wrappers that skip the shim
# directory.
if (-not (Get-Command _Safe_Pkg_Native_Exe -CommandType Function -ErrorAction SilentlyContinue)) {
    Write-Host "✗ safe-pnpm: the wrappers in $(Split-Path -Parent $file) are older than the PATH shims, so $name was not run. Run ``safe-pnpm update``, or take $shimDir off PATH."
    exit 1
}

$global:LASTEXITCODE = 0
try {
    & $name @rest
} catch {
    if ("$($_.Exception.Message)" -ne 'safe-pnpm: command refused') {
        Write-Host "✗ safe-pnpm: $($_.Exception.Message)"
    }
    if (-not $global:LASTEXITCODE) { $global:LASTEXITCODE = 1 }
}
exit $global:LASTEXITCODE
