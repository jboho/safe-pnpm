# _safe_pkg_shared.ps1 — shared prescan for safe-pnpm, safe-npm, safe-yarn (PowerShell)
# Dot-sourced by each manager wrapper. It only defines functions, so it loads
# again on every dot-source: a profile re-run after safe-pnpm update must not
# pair the new wrappers with the old functions.

# True when Path is a file in the PATH shim directory (~/.safe-pnpm/bin).
function _Safe_Pkg_Is_Shim {
    param([string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not $dir -or -not [IO.Path]::IsPathRooted($dir)) { return $false }
    $shim = [IO.Path]::GetFullPath((Join-Path $HOME '.safe-pnpm/bin')).TrimEnd('\', '/')
    return [IO.Path]::GetFullPath($dir).TrimEnd('\', '/') -eq $shim
}

# The real package manager executable. With the PATH shims on PATH, the first
# `Get-Command pnpm -CommandType Application` is the shim's pnpm.cmd, so this
# skips the shim directory and returns the next match. PATH itself is left
# alone, so a pnpm started by that process (a package script running
# `pnpm install`) reaches the shim again. See _safe_pkg_native in
# _safe_pkg_shared.sh. No real binary: refuses with 127 instead of running
# nothing.
function _Safe_Pkg_Native_Exe {
    param([string]$Name)
    foreach ($c in @(Get-Command $Name -CommandType Application -All -ErrorAction Ignore)) {
        if (-not (_Safe_Pkg_Is_Shim $c.Source)) { return $c.Source }
    }
    Write-Host "✗ safe-pnpm: no $Name found on PATH apart from the safe-pnpm PATH shims. Install $Name, or take the shims off PATH." -ForegroundColor Red
    $global:LASTEXITCODE = 127
    throw 'safe-pnpm: command refused'
}

# The cmd.exe command line that runs a .cmd or .bat Exe with Arguments, built
# like spawnCommand in lib/util/shims.js: each argument quoted for the
# program's parser, then every cmd.exe metacharacter caret-escaped twice, once
# for the /c line and once for the launcher's own %* reparse.
function _Safe_Pkg_Cmd_Line {
    param([string]$Exe, [object[]]$Arguments = @())
    $meta = '([()\][%!^"`<>&|;, *?])'
    $parts = @($Exe -replace $meta, '^$1')
    foreach ($a in $Arguments) {
        $q = '"' + (("$a" -replace '(\\*)"', '$1$1\"') -replace '(\\*)$', '$1$1') + '"'
        $parts += (($q -replace $meta, '^$1') -replace $meta, '^$1')
    }
    return ($parts -join ' ')
}

# Runs the real binary Exe with Arguments and leaves its exit code in
# $LASTEXITCODE; output stays in the pipeline, so `$v = npm -v` and redirects
# work. On Windows the real managers are .cmd launchers, and PowerShell passes
# arguments to a .cmd or .bat file the Legacy way: empty arguments dropped,
# embedded quotes unescaped, & and | left for cmd.exe to act on. So a .cmd or
# .bat runs through the system cmd.exe /d /s /c with the line from
# _Safe_Pkg_Cmd_Line, handed over verbatim by the stop-parsing token: --%
# passes the rest of the line as written, expanding only %_SAFE_PKG_CMDLINE%,
# once. That holds only under Legacy argument passing; with Standard (a
# profile may set it) PowerShell splits and re-quotes the line, so the call
# forces Legacy in this function's scope and the caller's setting is kept.
function _Safe_Pkg_Run_Native {
    param([string]$Exe, [object[]]$Arguments = @())
    if ($Exe -notmatch '\.(cmd|bat)$') {
        & $Exe @Arguments
        return
    }
    $root = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $cmd = [IO.Path]::Combine($root, 'System32', 'cmd.exe')
    $saved = $env:_SAFE_PKG_CMDLINE
    $env:_SAFE_PKG_CMDLINE = _Safe_Pkg_Cmd_Line $Exe $Arguments
    $PSNativeCommandArgumentPassing = 'Legacy'
    try {
        & $cmd /d /s /c --% "%_SAFE_PKG_CMDLINE%"
    } finally {
        $env:_SAFE_PKG_CMDLINE = $saved
    }
}

# The command that runs Name without the safety checks, for the refusal hints:
# Name.cmd, or the real binary's path when Name.cmd would reach the PATH shims
# and be refused again.
function _Safe_Pkg_Bypass {
    param([string]$Name)
    $first = Get-Command "$Name.cmd" -CommandType Application -ErrorAction Ignore | Select-Object -First 1
    if ($first -and (_Safe_Pkg_Is_Shim $first.Source)) {
        foreach ($c in @(Get-Command $Name -CommandType Application -All -ErrorAction Ignore)) {
            if (-not (_Safe_Pkg_Is_Shim $c.Source)) { return "& '$($c.Source -replace "'", "''")'" }
        }
    }
    return "$Name.cmd"
}

# Runs the manager's CVE audit on the tree phase 1 resolved, so a package
# passed to `add` is covered. Returns $false to block. See _safe_pkg_shared.sh
# for the full rationale. It runs on the host, so it audits a throwaway copy of
# the post-fetch snapshot plus the registry config (.npmrc from the sandbox, and
# .yarnrc without its yarn-path line), never the project. pnpm also skips the
# project's .pnpmfile.cjs, which would otherwise run on the host.
function _Safe_Pkg_Audit {
    param([string]$Manager, [string]$Lockfile, [string]$SnapDir, [string]$TmpDir)
    if (-not (Test-Path -LiteralPath (Join-Path $SnapDir $Lockfile) -PathType Leaf)) { return $true }

    $mgr = (_Safe_Pkg_Native_Exe $Manager)
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
    # yarn v1 spells it as a subcommand: yarn global add|remove|upgrade
    $words = @($PassArgs | Where-Object { $_ -notlike '-*' })
    if ($words.Count -ge 2 -and $words[0] -eq 'global' -and $words[1] -in @('add','remove','upgrade')) { return $true }
    $loc = $false
    foreach ($a in $PassArgs) {
        $a = [string]$a
        if ($loc -and $a -ceq 'global') { return $true }
        $loc = $false
        if ($a -eq '--') { return $false }
        if ($a -notlike '-*') { continue }
        $name = $a -replace '^-+', ''
        $parts = $name -split '=', 2
        $key = $parts[0]
        $hasVal = $parts.Count -eq 2
        $val = if ($hasVal) { $parts[1] } else { '' }
        if (-not $key) { continue }
        if ($a -like '--*') {
            if ('global'.StartsWith($key, [StringComparison]::Ordinal) -and $val -cne 'false') { return $true }
            if ($key.Length -ge 3 -and 'location'.StartsWith($key, [StringComparison]::Ordinal)) {
                if ($hasVal) { if ($val -ceq 'global') { return $true } } else { $loc = $true }
            }
        } elseif ($key -clike '*g*') {
            if ($key -cne 'g' -or $val -cne 'false') { return $true }
        }
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

# Returns what marks Dir as a Yarn 2+ (Berry) project, or $null. See
# _safe_pkg_yarn_berry in _safe_pkg_shared.sh. The files are read one byte per
# character and the version is compared as text, as grep and `case` do there:
# a number conversion fails on a long run of digits, and outside a try that
# failure only prints an error, which left a Berry project looking like Yarn 1.
# ReadAllText is not used: it switches to UTF-8 or UTF-16 when the file starts
# with a byte order mark. An unreadable file throws; the caller refuses.
function _Safe_Pkg_Yarn_Berry {
    param([string]$Dir)
    $bytes = [Text.Encoding]::GetEncoding(28591)
    $lock = [IO.Path]::Combine($Dir, 'yarn.lock')
    if ([IO.File]::Exists($lock) -and [regex]::IsMatch($bytes.GetString([IO.File]::ReadAllBytes($lock)), '(?m)^__metadata:')) {
        return "$lock is a Yarn 2+ lockfile"
    }
    $rc = [IO.Path]::Combine($Dir, '.yarnrc.yml')
    if ([IO.File]::Exists($rc)) { return "$rc is a Yarn 2+ settings file" }
    $pkg = [IO.Path]::Combine($Dir, 'package.json')
    if ([IO.File]::Exists($pkg)) {
        $m = [regex]::Match($bytes.GetString([IO.File]::ReadAllBytes($pkg)), '"packageManager"[ \t\v\f\r]*:[ \t\v\f\r]*"(yarn@[0-9][0-9.]*)')
        if ($m.Success -and $m.Groups[1].Value -cmatch '\Ayarn@(?:[2-9]|[1-9][0-9])') {
            return "$pkg sets packageManager to $($m.Groups[1].Value -creplace '\.\z', '')"
        }
    }
    return $null
}

# The root of the Yarn 2+ project the current directory belongs to, or $null
# when it is not in one. See _safe_pkg_yarn_berry_root in _safe_pkg_shared.sh:
# the nearest yarn.lock at or above the current directory, below $HOME and the
# filesystem root, names the root. The loop ends when a folder has no parent
# or the parent is not shorter, so it cannot spin on a path it cannot shorten.
function _Safe_Pkg_Yarn_Berry_Root {
    $cwd = (Get-Location).ProviderPath
    $root = $cwd
    $d = $cwd
    $cmp = [StringComparison]::Ordinal
    if ($IsWindows -or $env:OS -eq 'Windows_NT') { $cmp = [StringComparison]::OrdinalIgnoreCase }
    while ($d -and -not [string]::Equals($d, $HOME, $cmp)) {
        $parent = [IO.Path]::GetDirectoryName($d)
        if (-not $parent -or $parent.Length -ge $d.Length) { break }
        if ([IO.File]::Exists([IO.Path]::Combine($d, 'yarn.lock'))) { $root = $d; break }
        $d = $parent
    }
    if ((_Safe_Pkg_Yarn_Berry -Dir $root) -or (_Safe_Pkg_Yarn_Berry -Dir $cwd)) { return $root }
    return $null
}

# Full path of a program on PATH, or $null. Functions and aliases are skipped,
# and the path is absolute because Windows looks in the current folder before
# PATH when it starts a program by bare name.
function _Safe_Pkg_App {
    param([string]$Name)
    $c = Get-Command $Name -CommandType Application -ErrorAction Ignore | Select-Object -First 1
    if ($c) { return $c.Source }
    return $null
}

# Runs a program with exactly these arguments and returns its exit code, and
# with -Capture its output. `& exe @args` does not pass them exactly: on Linux
# and macOS PowerShell expands * ? [ ] and ~ in them against the current
# folder, and before PowerShell 7.3 it drops empty arguments and splits one
# that holds a quote. A folder or package name must not turn into docker flags.
# Without -Capture the program writes to the terminal directly.
function _Safe_Pkg_Exec {
    param([string]$Exe, [string[]]$Arguments, [string]$WorkDir, [switch]$Capture)
    # A .cmd or .bat goes through cmd.exe, which reads the arguments again.
    if ($IsWindows -and [IO.Path]::GetExtension($Exe) -ine '.exe') {
        throw "safe-pnpm: $Exe is not an .exe, so its arguments cannot be passed safely"
    }
    $psi = [Diagnostics.ProcessStartInfo]::new($Exe)
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = (Get-Location).ProviderPath
    if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
    if ($Capture) {
        $utf8 = [Text.UTF8Encoding]::new($false)
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $utf8
        $psi.StandardErrorEncoding = $utf8
    }
    foreach ($a in $Arguments) {
        if ($null -eq $a) { throw 'safe-pnpm: an empty argument slot reached _Safe_Pkg_Exec' }
        $psi.ArgumentList.Add($a)
    }
    $p = [Diagnostics.Process]::Start($psi)
    try {
        $out = ''
        $err = ''
        if ($Capture) {
            $o = $p.StandardOutput.ReadToEndAsync()
            $e = $p.StandardError.ReadToEndAsync()
        }
        # A short wait in a loop, so Ctrl-C is seen between two waits.
        while (-not $p.WaitForExit(200)) { }
        if ($Capture) {
            $out = $o.GetAwaiter().GetResult()
            $err = $e.GetAwaiter().GetResult()
        }
        return [pscustomobject]@{ Rc = [int]$p.ExitCode; Out = $out; Err = $err }
    } finally {
        if (-not $p.HasExited) { try { if (-not $p.WaitForExit(3000)) { $p.Kill() } } catch { } }
        $p.Dispose()
    }
}

function _Safe_Pkg_Refuse {
    param([string]$Message)
    Write-Host "✗ safe-pnpm: $Message" -ForegroundColor Red
    $global:LASTEXITCODE = 1
    throw 'safe-pnpm: command refused'
}

# Runs one mode of ~/.safe-pnpm/yarn-berry-check.js (the Yarn 2+ checks and the
# sandbox file staging; see that file) and returns its answer. Anything but a
# complete "ok" answer is Ok = $false with a Reason: a missing helper or node,
# a non-zero exit, output without the closing "end" line, or a line this
# cannot decode. The helper runs from its own folder with absolute paths only:
# a node preload reads the package.json of the current folder first, and dies
# on one that is not JSON.
function _Safe_Pkg_Yarn_Berry_Helper {
    param([string]$Mode, [string[]]$Arguments)
    $r = [pscustomobject]@{ Ok = $false; Reason = ''; Spec = ''; Members = [string[]]@() }
    try {
        $dir = [IO.Path]::Combine($HOME, '.safe-pnpm')
        $helper = [IO.Path]::Combine($dir, 'yarn-berry-check.js')
        if (-not [IO.File]::Exists($helper)) {
            $r.Reason = "the Yarn 2+ checks are not installed ($helper is missing); run safe-pnpm update."
            return $r
        }
        $node = _Safe_Pkg_App node
        if (-not $node) {
            $r.Reason = 'node was not found on PATH, and the Yarn 2+ sandbox needs it.'
            return $r
        }
        $run = _Safe_Pkg_Exec -Exe $node -Arguments (@($helper, $Mode) + @($Arguments)) -WorkDir $dir -Capture
        $tail = ($run.Err -creplace '[^ -~]', ' ').Trim()
        if ($tail.Length -gt 300) { $tail = $tail.Substring(0, 300) }
        $bad = "the Yarn 2+ helper ($helper) gave no answer the wrapper can read (exit $($run.Rc)). $tail".Trim()
        $lines = @($run.Out.Split([char]10))
        $n = $lines.Count
        $first = $lines[0]
        $isOk = [string]::Equals($first, 'ok', [StringComparison]::Ordinal)
        if ($run.Rc -ne 0 -or $n -lt 3 -or $lines[$n - 1].Length -ne 0 -or
            -not [string]::Equals($lines[$n - 2], 'end', [StringComparison]::Ordinal) -or
            -not ($isOk -or [string]::Equals($first, 'refuse', [StringComparison]::Ordinal))) {
            $r.Reason = $bad
            return $r
        }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $reason = ''
        $spec = ''
        $members = [Collections.Generic.List[string]]::new()
        for ($i = 1; $i -le $n - 3; $i++) {
            $m = [regex]::Match($lines[$i], '\A(reason|spec|member) ([A-Za-z0-9+/=]*)\z')
            if (-not $m.Success) { $r.Reason = $bad; return $r }
            $val = $utf8.GetString([Convert]::FromBase64String($m.Groups[2].Value))
            # Only these three words can be here, so -ceq cannot be misled.
            if ($m.Groups[1].Value -ceq 'reason') { $reason = $val -creplace '[\x00-\x08\x0B-\x1F\x7F]', '' }
            elseif ($m.Groups[1].Value -ceq 'spec') { $spec = $val }
            else {
                # A member is a folder under the root, written with "/". It is
                # joined to the sandbox and project paths for the copy back.
                $bs = $val.IndexOf([char]92) -ge 0
                $odd = $val.Length -eq 0 -or $val.IndexOf([char]0) -ge 0 -or [IO.Path]::IsPathRooted($val)
                foreach ($seg in $val.Split([char]47)) {
                    if ($seg.Length -eq 0 -or [string]::Equals($seg, '.', [StringComparison]::Ordinal) -or
                        [string]::Equals($seg, '..', [StringComparison]::Ordinal)) { $odd = $true }
                }
                if ($odd) { $r.Reason = $bad; return $r }
                if ($bs) {
                    $r.Reason = "the workspace folder $($val -creplace '[^ -~]', '?') has a backslash in its name, which the PowerShell wrapper cannot copy back; nothing was installed."
                    return $r
                }
                $members.Add($val)
            }
        }
        if (-not $isOk) {
            if (-not $reason) { $reason = "the Yarn 2+ helper refused ($Mode) without a reason." }
            $r.Reason = $reason
            return $r
        }
        $r.Spec = $spec
        $r.Members = [string[]]$members.ToArray()
        $r.Ok = $true
    } catch {
        $r.Ok = $false
        $r.Reason = "the Yarn 2+ helper could not run: $($_.Exception.Message)"
    }
    return $r
}

# The checks a Yarn 2+ project must pass before the sandbox runs it; see
# _safe_pkg_yarn_berry_check in _safe_pkg_shared.sh. Subcmd is the word the
# wrapper's walk settled on. Returns Ok with the exact Yarn pin in Spec, or
# Ok = $false with the reason to print.
function _Safe_Pkg_Yarn_Berry_Check {
    param([string]$Root, [string]$Subcmd)
    if (-not (_Safe_Pkg_App node)) {
        return [pscustomobject]@{
            Ok = $false
            Reason = "$([IO.Path]::Combine($Root, 'package.json')): the wrapper could not check the package.json files with node, so it does not run the command."
            Spec = ''
            Members = [string[]]@()
        }
    }
    $r = _Safe_Pkg_Yarn_Berry_Helper -Mode check -Arguments @($Root, $HOME, $Subcmd)
    if ($r.Ok -and $r.Spec -cnotmatch '\Ayarn@(?:[3-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.]+)?\z') {
        $r.Ok = $false
        $r.Reason = "the Yarn 2+ helper returned no exact Yarn pin for $Root."
    }
    return $r
}

# The Yarn 2+ audit: `yarn npm audit` in a container with the pinned Yarn,
# because the yarn on this machine may be Yarn 1 or missing. Same messages and
# rules as _Safe_Pkg_Audit.
function _Safe_Pkg_Yarn_Berry_Audit {
    param([string]$Docker, [string]$SnapDir, [string[]]$RunArgs)
    if (-not [IO.File]::Exists([IO.Path]::Combine($SnapDir, 'tree', 'yarn.lock'))) { return $true }
    Write-Host "→ yarn audit..." -ForegroundColor Cyan
    $run = _Safe_Pkg_Exec -Exe $Docker -Arguments $RunArgs -Capture
    if ($run.Rc -eq 0) { return $true }
    $lines = @(($run.Out + $run.Err) -split "`r?`n" | Where-Object { $_ })
    foreach ($l in @($lines | Select-Object -Last 40)) { [Console]::Error.WriteLine($l) }
    if ($env:SAFE_PNPM_STRICT -eq '1') {
        Write-Host "✗ yarn audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." -ForegroundColor Red
        return $false
    }
    if (-not [Console]::IsInputRedirected) {
        $ans = Read-Host "⚠️  yarn audit failed or found issues. Continue anyway? [y/N]"
        if ($ans -notmatch '^[Yy]') { return $false }
    } else {
        Write-Host "⚠️  yarn audit failed or found issues — continuing in non-interactive mode." -ForegroundColor Yellow
    }
    return $true
}

# The two-phase sandbox for a Yarn 2+ project; see the Yarn 2+ steps of
# _safe_pkg_sandbox in _safe_pkg_shared.sh. Root is the project root, Spec the
# packageManager pin corepack runs in every container. A failure before the
# first container is a refusal; a later one sets $LASTEXITCODE, as the Yarn 1
# sandbox does. -Os and -Cpu override the detected host platform (tests).
function _Safe_Pkg_Yarn_Berry_Run {
    param([string]$Root, [string]$Spec, [string[]]$PassArgs, [string]$Os, [string]$Cpu)
    $tmp = $null
    $snap = $null
    $rc = 1
    try {
        if (-not $Root -or $Spec -cnotmatch '\Ayarn@[0-9]') {
            _Safe_Pkg_Refuse 'the Yarn 2+ sandbox was started without a project root or a Yarn pin; nothing was installed.'
        }
        $docker = _Safe_Pkg_App docker
        if (-not $docker) { _Safe_Pkg_Refuse 'docker was not found on PATH; nothing was installed.' }

        # The folder the command ran in, as a path under /app.
        $cwd = (Get-Location).ProviderPath
        $cmp = [StringComparison]::Ordinal
        if ($IsWindows -or $env:OS -eq 'Windows_NT') { $cmp = [StringComparison]::OrdinalIgnoreCase }
        $sep = [string][IO.Path]::DirectorySeparatorChar
        $workdir = '/app'
        if ($cwd.Length -gt $Root.Length -and $cwd.StartsWith($Root, $cmp)) {
            $rel = $cwd.Substring($Root.Length)
            if ($rel.StartsWith($sep, [StringComparison]::Ordinal)) { $rel = $rel.Substring(1) }
            if ($sep -ne '/') { $rel = $rel.Replace($sep, '/') }
            if ($rel) { $workdir = "/app/$rel" }
        }

        $userFlags = @()
        try { $userFlags = @(_Safe_Pkg_User) } catch {
            Write-Host "✗ $($_.Exception.Message)" -ForegroundColor Red
            $global:LASTEXITCODE = 1
            throw 'safe-pnpm: command refused'
        }

        if (-not $Os) {
            $P = [Runtime.InteropServices.OSPlatform]
            if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::Windows)) { $Os = 'win32' }
            elseif ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform($P::OSX)) { $Os = 'darwin' }
        }
        if (-not $Cpu) {
            $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
            if ($arch -eq 'X64') { $Cpu = 'x64' } elseif ($arch -eq 'Arm64') { $Cpu = 'arm64' }
        }
        if (-not $Os) { $Os = '-' }
        if (-not $Cpu) { $Cpu = '-' }

        $tmp = (New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }).FullName
        # Host-only, never mounted into a container: the post-fetch manifest
        # snapshots that copy-back reads from.
        $snap = (New-TemporaryFile | ForEach-Object { Remove-Item $_ -Force; New-Item -Type Directory $_ }).FullName

        # Manifests, lockfile, settings files, member manifests and patches go
        # into the sandbox; a file that cannot be copied stops the run here.
        $staged = _Safe_Pkg_Yarn_Berry_Helper -Mode stage -Arguments @($Root, $HOME, $tmp, $snap, $Os, $Cpu)
        if (-not $staged.Ok) { _Safe_Pkg_Refuse $staged.Reason }
        $members = @($staged.Members)

        $hard = @(_Safe_Pkg_Hardening)
        # Every Yarn 2+ container: corepack keeps the pinned Yarn in the
        # sandbox, yarnPath is ignored, the cache sits in the sandbox, no
        # telemetry. HOME is set when the user flags leave it out (Windows,
        # rootless Docker), so Yarn finds the sandbox ~/.yarnrc.yml.
        $berryEnv = @('-e','COREPACK_HOME=/app/.corepack','-e','COREPACK_ENABLE_DOWNLOAD_PROMPT=0','-e','YARN_IGNORE_PATH=1',
            '-e','YARN_CACHE_FOLDER=/app/.safe-store','-e','YARN_ENABLE_GLOBAL_CACHE=0','-e','YARN_ENABLE_TELEMETRY=0')
        if (-not @($userFlags | Where-Object { "$_".StartsWith('HOME=', [StringComparison]::Ordinal) }).Count) {
            $berryEnv += @('-e','HOME=/app/.safe-home')
        }
        $noScripts = @('-e','YARN_ENABLE_SCRIPTS=0','-e','YARN_INJECT_ENVIRONMENT_FILES=/nonexistent/.env.yarn?')

        # Tokens are forwarded only into the fetch and audit containers, where
        # no package code runs. They are never present during phase 2.
        $tokenEnv = @()
        if ($env:NODE_AUTH_TOKEN) { $tokenEnv += @('-e','NODE_AUTH_TOKEN') }
        if ($env:NPM_TOKEN)       { $tokenEnv += @('-e','NPM_TOKEN') }
        $tokenEnv += @(_Safe_Pkg_User_Auth -TmpDir $tmp)

        $yarnArgs = @()
        foreach ($a in $PassArgs) { $yarnArgs += "$a" }
        if (-not $yarnArgs.Count) { $yarnArgs = @('install') }

        # Phase 1: fetch (network on, token available, scripts disabled).
        $mount = @('-v', "${tmp}:/app", '-w', $workdir)
        $p1 = @('run','--rm','--cap-drop','ALL') + $hard + $userFlags + $mount + $tokenEnv + $berryEnv + $noScripts +
            @('safe-pnpm:latest','corepack',$Spec) + $yarnArgs + @('--mode=skip-build')
        $rc = (_Safe_Pkg_Exec -Exe $docker -Arguments $p1).Rc

        # From here on $fetched says whether the sandbox may still be built
        # and copied back; every failed step clears it.
        $fetched = $false
        if ($rc -eq 0) {
            if (_Safe_Pkg_Malware_Scan (Join-Path $tmp 'yarn.lock')) { $fetched = $true } else { $rc = 1 }
        }

        if ($fetched) {
            $step = _Safe_Pkg_Yarn_Berry_Helper -Mode snapshot -Arguments @($tmp, $snap)
            if (-not $step.Ok) {
                Write-Host "✗ safe-pnpm: $($step.Reason)" -ForegroundColor Red
                $fetched = $false
                $rc = 1
            }
        }

        if ($fetched) {
            $pa = @('run','--rm','--cap-drop','ALL') + $hard + $userFlags + $tokenEnv + $berryEnv + $noScripts + $mount +
                @('safe-pnpm:latest','corepack',$Spec,'npm','audit','--all','--recursive','--severity','moderate')
            if (-not (_Safe_Pkg_Yarn_Berry_Audit -Docker $docker -SnapDir $snap -RunArgs $pa)) {
                $fetched = $false
                $rc = 1
            }
        }

        if ($fetched) {
            # Strip registry credentials before any build script can run.
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmp '.npmrc')
            _Safe_Pkg_Strip_NpmrcAuth (Join-Path $tmp '.yarnrc')
            $homeNpmrc = [IO.Path]::Combine($tmp, '.safe-home', '.npmrc')
            if ([IO.File]::Exists($homeNpmrc)) { [IO.File]::Delete($homeNpmrc) }
            $step = _Safe_Pkg_Yarn_Berry_Helper -Mode strip -Arguments @($tmp)
            if (-not $step.Ok) {
                Write-Host "✗ safe-pnpm: $($step.Reason)" -ForegroundColor Red
                $fetched = $false
                $rc = 1
            }
        }

        if ($fetched) {
            $netFlag = @('--network','none')
            if ($env:SAFE_PNPM_BUILD_NETWORK -eq '1') { $netFlag = @() }

            # Phase 2: build (no token, no credentials in the settings files,
            # network off by default). Yarn and corepack stay offline even
            # under SAFE_PNPM_BUILD_NETWORK=1.
            $p2 = @('run','--rm','--cap-drop','ALL') + $hard + $userFlags + $netFlag + $mount + $berryEnv +
                @('-e','YARN_ENABLE_NETWORK=0','-e','COREPACK_ENABLE_NETWORK=0','safe-pnpm:latest','corepack',$Spec,'install','--immutable')
            $rc = (_Safe_Pkg_Exec -Exe $docker -Arguments $p2).Rc

            if (-not (_Safe_Pkg_Copy_Modules -Base $tmp -Rel 'node_modules' -DestRoot $Root)) { $rc = 1 }
            foreach ($m in $members) {
                if (-not (_Safe_Pkg_Copy_Modules -Base $tmp -Rel "$m/node_modules" -DestRoot $Root)) { $rc = 1 }
            }
            # Manifests and lockfile come from the snapshot taken after the
            # fetch, never from the sandbox the build scripts could write to.
            $step = _Safe_Pkg_Yarn_Berry_Helper -Mode restore -Arguments @($snap, $Root)
            if (-not $step.Ok) {
                Write-Host "✗ safe-pnpm: $($step.Reason)" -ForegroundColor Red
                $rc = 1
            }
        }
    } catch {
        if ($_.Exception.Message -eq 'safe-pnpm: command refused') { throw }
        Write-Host "✗ safe-pnpm: the Yarn 2+ sandbox stopped on an error: $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        throw 'safe-pnpm: command refused'
    } finally {
        # $tmp holds a copy of the registry credentials; remove both folders
        # even if the run is interrupted with Ctrl-C.
        foreach ($d in @($tmp, $snap)) {
            if ($d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Ignore }
        }
    }
    $global:LASTEXITCODE = $rc
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

# Returns what turns off pnpm's shared workspace lockfile, or $null. See
# _safe_pkg_unshared_lockfile_setting in _safe_pkg_shared.sh.
function _Safe_Pkg_Unshared_Lockfile_Setting {
    param([string]$Dir, [string]$Root, [string[]]$PassArgs)
    $keyRe = 'shared-?workspace-?(?:lockfile|shrinkwrap)'
    $checks = @(
        @('.npmrc', "^\s*[""']?($keyRe)[""']?\s*=\s*[""']?false(?:[^a-z0-9]|$)"),
        @('pnpm-workspace.yaml', "^[^#]*?($keyRe)[""']?\s*:\s*[""']?false(?:[^a-z0-9]|$)")
    )
    foreach ($c in $checks) {
        $path = Join-Path $Dir $c[0]
        if (-not (Test-Path -LiteralPath $path)) { continue }
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line -match $c[1]) { return "$(Join-Path $Root $c[0]) sets $($Matches[1]) to false" }
        }
    }
    $prev = $null
    foreach ($a in $PassArgs) {
        if ($prev) {
            if ($a -eq 'false') { return "$prev $a sets shared-workspace-lockfile to false" }
            $prev = $null
        }
        if ($a -ceq '--') { return $null }
        if ($a -notlike '-*') { continue }
        $parts = ([string]$a -split '=', 2)
        $key = ($parts[0] -replace '^-+', '').ToLowerInvariant() -replace '^config\.', '' -replace '[-_]', ''
        $neg = $key.StartsWith('no')
        if ($neg) { $key = $key.Substring(2) }
        if ($key -notmatch '^shared[a-z]*$') { continue }
        if (-not ('sharedworkspacelockfile'.StartsWith($key) -or 'sharedworkspaceshrinkwrap'.StartsWith($key))) { continue }
        if ($parts.Count -eq 2) {
            if ($neg -ne ($parts[1] -eq 'false')) { return "$a sets shared-workspace-lockfile to false" }
            continue
        }
        if ($neg) { return "$a sets shared-workspace-lockfile to false" }
        $prev = $a
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

    # A missing `node` leaves $LASTEXITCODE at the Socket CLI's exit code, which
    # would read as a pass; classify it as a scan failure instead.
    if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
        $reason = (& node $classifier $out.FullName $rc 2>&1 | Out-String).Trim()
        $verdict = $LASTEXITCODE
    } else {
        $reason = "node not found; Socket results cannot be read."
        $verdict = 4
    }
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
    # The wrapper refuses an install when an update left this function out; here
    # an unknown directory flag just reads like any unlisted flag.
    $hasDirFlag = [bool](Get-Command _Safe_Pkg_Dir_Flag -ErrorAction SilentlyContinue)
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
                if (($valueFlags -ccontains $a) -or ($hasDirFlag -and [bool](_Safe_Pkg_Dir_Flag -Manager $Manager -PassArgs @($a)))) { $maybe = $false; $skip = 'value' }
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
    # The tag tells malware-scan.js to refuse a spec that names no version.
    $tag = if ($Manager -eq 'npm') { 'exec-npm:' } else { 'exec-dlx:' }
    foreach ($spec in $(if ($pkgList.Count) { $pkgList } else { $pos })) { if ($spec) { "$tag$spec" } }
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

# Copies the user's own .npmrc auth lines whose value is exactly
# ${NODE_AUTH_TOKEN} or ${NPM_TOKEN} into the sandbox and returns the docker
# flags that make that copy the container's user config. See
# _safe_pkg_user_auth in _safe_pkg_shared.sh.
function _Safe_Pkg_User_Auth {
    param([string]$TmpDir)
    $src = if ($env:NPM_CONFIG_USERCONFIG) { $env:NPM_CONFIG_USERCONFIG }
        elseif ($env:npm_config_userconfig) { $env:npm_config_userconfig }
        else { Join-Path $HOME '.npmrc' }
    $vars = @()
    if ($env:NODE_AUTH_TOKEN) { $vars += 'NODE_AUTH_TOKEN' }
    if ($env:NPM_TOKEN)       { $vars += 'NPM_TOKEN' }
    if ($vars.Count -eq 0 -or -not (Test-Path -LiteralPath $src -PathType Leaf)) { return }
    $pattern = '^\s*//[^\s=]+:_auth(Token)?\s*=\s*\$\{(' + ($vars -join '|') + ')\}\s*$'
    $lines = @(Get-Content -LiteralPath $src | Where-Object { $_ -cmatch $pattern })
    if ($lines.Count -eq 0) { return }
    $dir = Join-Path $TmpDir '.safe-home'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [IO.File]::WriteAllLines((Join-Path $dir '.npmrc'), [string[]]$lines)
    return @('-e', 'NPM_CONFIG_USERCONFIG=/app/.safe-home/.npmrc')
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
    $exe = (_Safe_Pkg_Native_Exe $Manager)
    if ([Console]::IsInputRedirected) {
        if ($env:SAFE_PNPM_ALLOW_NATIVE_FALLBACK -eq '1') {
            Write-Host "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native $Manager." -ForegroundColor Yellow
            _Safe_Pkg_Run_Native $exe $PassArgs
            return
        }
        Write-Host "✗ safe-pnpm: Docker not running and no TTY — refusing native $Manager (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." -ForegroundColor Red
        $global:LASTEXITCODE = 1
        throw 'safe-pnpm: command refused'
    }
    $ans = Read-Host "⚠️  safe-pnpm: Docker not running. Use native $Manager? [y/N]"
    if ($ans -match '^[Yy]') {
        _Safe_Pkg_Run_Native $exe $PassArgs
    } else {
        $global:LASTEXITCODE = 1
        throw 'safe-pnpm: command refused'
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
    # Not New-Item: it trims a trailing space from the folder name, and would
    # create "packages/a" next to a member folder named "packages/a ".
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
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
    $node = _Safe_Pkg_App node
    if (-not $node) {
        Write-Host "✗ safe-pnpm: node not found; link check cannot run. $Rel not copied back." -ForegroundColor Red
        return $false
    }
    # Rel holds folder names from the project, so node gets it as one exact
    # argument (see _Safe_Pkg_Exec). An error counts as a failed check.
    $rc = 1
    $out = ''
    try {
        $run = _Safe_Pkg_Exec -Exe $node -Arguments @($checker, $Base, $Rel) -WorkDir (Split-Path $checker -Parent) -Capture
        $rc = $run.Rc
        $out = ($run.Out + $run.Err).Trim()
    } catch { $out = "$($_.Exception.Message)" }
    if ($rc -ne 0) {
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
