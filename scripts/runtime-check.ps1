[CmdletBinding()]
param(
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [switch]$Detailed
)

# Checks that the guards themselves still work.
#
# Every mechanical gate in this system has, at some point, been broken and silent at the same
# time: a .ps1 whose newlines were lost so the whole file read as one comment and exited 0; hooks
# saved without a BOM so PowerShell 5.1 read them as ANSI and died in the parser before any
# try/catch existed; two core scripts missing from the manifest so the installer never copied
# them; and a whole session's worth of fixes that only ever existed in the repo while the hooks
# actually running were the previous version. None of those announced themselves - the gate just
# stopped catching things.
#
# Output is [PASS]/[FAIL]/[WARN]/[SKIP] lines, matching pre-review.ps1, which calls this first.

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$failures = 0

function Add-Pass([string]$Name) { Write-Output "[PASS] $Name" }
function Add-Skip([string]$Name, [string]$Reason) { Write-Output "[SKIP] $Name - $Reason" }
function Add-Warn([string]$Name, [string]$Detail) { Write-Output "[WARN] $Name - $Detail" }
function Add-Fail([string]$Name, [string[]]$Details) {
    Write-Output "[FAIL] $Name"
    foreach ($detail in $Details) { Write-Output "       $detail" }
    $script:failures++
}

function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$stateFile = Join-Path $StateRoot 'managed-runtime.json'
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    Add-Skip 'runtime manifest' "no managed-runtime.json under $StateRoot (agent-workflow is not installed here)"
    exit 0
}

$state = $null
try { $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
if (-not $state) { Add-Fail 'runtime manifest' @("unreadable: $stateFile"); exit 1 }
Add-Pass 'runtime manifest'

# --- 1. installed files still match what the installer wrote ------------------------------
$tampered = @()
$missing = @()
# Entrypoints merge a managed block into a file the user also owns (CLAUDE.md, AGENTS.md), so
# their hash is expected to move and says nothing about the guards. Every other kind is written
# wholesale by the installer: a changed hash there means someone edited the installed copy, which
# the next install silently overwrites.
$userOwnedKinds = @('canonical-entrypoint', 'canonical-hardlink')
foreach ($item in @($state.files)) {
    if (-not $item.sha256) { continue }
    if ($userOwnedKinds -contains $item.kind) { continue }
    if (-not (Test-Path -LiteralPath $item.path -PathType Leaf)) { $missing += $item.path; continue }
    if ((Get-Hash $item.path) -ne $item.sha256) { $tampered += $item.path }
}
if ($missing -or $tampered) {
    $details = @()
    foreach ($path in $missing) { $details += "missing: $path" }
    foreach ($path in $tampered) { $details += "content changed since install: $path" }
    $details += 'run install.ps1 -Action Repair to restore the managed runtime.'
    Add-Fail 'installed runtime integrity' $details
} else {
    Add-Pass 'installed runtime integrity'
}

# --- 2. every installed .ps1 still parses, has real line structure and safe encoding -------
$broken = @()
foreach ($item in @($state.files)) {
    if ($item.path -notlike '*.ps1') { continue }
    if (-not (Test-Path -LiteralPath $item.path -PathType Leaf)) { continue }

    $bytes = [IO.File]::ReadAllBytes($item.path)
    # A script whose newlines were lost collapses into a single line; if that line starts with a
    # comment, PowerShell parses it happily and exits 0, which reads exactly like "the check
    # passed". Any real script here is multi-line.
    $newlineCount = @($bytes | Where-Object { $_ -eq 0x0A }).Count
    if ($newlineCount -lt 1) { $broken += "$($item.path): file has no line breaks (a one-line script silently no-ops)" }

    # PowerShell 5.1 reads a BOM-less file as the system ANSI code page. That is fine while the
    # file is pure ASCII and corrupts every non-ASCII literal the moment it is not - which is how
    # two contract-test assertions ended up permanently true.
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasNonAscii = @($bytes | Where-Object { $_ -ge 0x80 }).Count -gt 0
    if (-not $hasBom -and $hasNonAscii) { $broken += "$($item.path): non-ASCII bytes without a UTF-8 BOM (PowerShell 5.1 will read them as ANSI)" }

    $parseErrors = $null
    $tokens = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($item.path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and @($parseErrors).Count -gt 0) {
        $broken += "$($item.path): parse error - $(@($parseErrors)[0].Message)"
    }
}
if ($broken) { Add-Fail 'runtime script health' $broken } else { Add-Pass 'runtime script health' }

# --- 3. the installed runtime is the current repo version ---------------------------------
# The gate that is running is the installed copy, never the repo. A session can pass every test
# in the repo while the hooks actually protecting the work are the previous release.
$source = [string]$state.source
$manifestPath = if ($source) { Join-Path $source 'adapters\managed-manifest.json' } else { '' }
if (-not $source -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Add-Skip 'runtime matches repo' 'the source repository recorded at install time is not available here'
} else {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $runtimeRoot = Join-Path $StateRoot 'runtime'
    $drift = @()
    foreach ($relative in @($manifest.runtime)) {
        # install.ps1's Get-SharedSource: agents/ and skills/ come from the canonical .agents tree,
        # everything else straight from the repo root.
        $repoPath = if ($relative -like 'agents/*' -or $relative -like 'skills/*') {
            Join-Path $source ('.agents\' + $relative.Replace('/', '\'))
        } else {
            Join-Path $source $relative.Replace('/', '\')
        }
        $installedPath = Join-Path $runtimeRoot $relative.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $repoPath -PathType Leaf)) { $drift += "listed in the manifest but missing from the repo: $relative"; continue }
        if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { $drift += "never installed: $relative"; continue }
        if ((Get-Hash $repoPath) -ne (Get-Hash $installedPath)) { $drift += "repo is ahead of the installed runtime: $relative" }
    }
    if ($drift) {
        $drift += 'run install.ps1 -Action Repair; until then the running gates are the previously installed version.'
        Add-Fail 'runtime matches repo' $drift
    } else {
        Add-Pass 'runtime matches repo'
    }
}

# --- 4. surface hooks that failed open -----------------------------------------------------
# git-guard and impact-guard release the tool call when they throw, on purpose. This is the only
# place that failure becomes visible.
$hookLog = Join-Path $StateRoot 'logs\hook-errors.log'
if (Test-Path -LiteralPath $hookLog -PathType Leaf) {
    $entries = @(Get-Content -LiteralPath $hookLog -ErrorAction SilentlyContinue | Where-Object { $_ })
    if ($entries.Count -gt 0) {
        Add-Warn 'hook failure log' "$($entries.Count) entr$(if ($entries.Count -eq 1) { 'y' } else { 'ies' }) in $hookLog; most recent: $($entries[-1])"
        if ($Detailed) { $entries | ForEach-Object { Write-Output "       $_" } }
    } else {
        Add-Pass 'hook failure log'
    }
} else {
    Add-Pass 'hook failure log'
}

# --- 5. surface Codex hooks that are installed but not yet trusted -------------------------
# Codex requires each hook entry to be individually trusted in config.toml
# ([hooks.state."<hooks.json path>:<event>:<matcher index>:<hook index>"], trusted_hash = ...)
# before it will run at all. install.ps1 can only write hooks.json; granting trust only happens
# inside an interactive Codex session. Warned, not failed: this is a step the user has to take
# themselves, not something a re-install can fix - but it must not stay silent, since an
# untrusted hook and a correctly installed one look identical in every other check above.
$codexHooksEntry = @($state.files) | Where-Object {
    $_.kind -eq 'merged-hooks' -and $_.path -match '\\hooks\.json$' -and
    (Split-Path -Leaf (Split-Path -Parent $_.path)) -ne 'config'
} | Select-Object -First 1
if (-not $codexHooksEntry) {
    Add-Skip 'codex hook trust' 'no merged Codex hooks.json recorded in the runtime manifest (Codex was not installed here)'
} else {
    $hooksData = $null
    try { $hooksData = Get-Content -LiteralPath $codexHooksEntry.path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if (-not $hooksData -or -not $hooksData.PSObject.Properties['hooks']) {
        Add-Skip 'codex hook trust' "cannot read $($codexHooksEntry.path)"
    } else {
        # Get-UntrustedCodexHookKeys: shared with install.ps1 - see codex-hook-trust.ps1 for why
        # this is dot-sourced rather than copied (the two used to carry independent copies of
        # the same event-name map, TOML-key regex and key-computation loop). The readability
        # check above stays local: it decides SKIP vs PASS/WARN, a distinction the shared
        # function does not need to make for install.ps1's caller (which has no SKIP concept).
        . (Join-Path $PSScriptRoot 'codex-hook-trust.ps1')
        $codexConfigToml = Join-Path (Split-Path -Parent $codexHooksEntry.path) 'config.toml'
        $hooksDir = Join-Path $StateRoot 'runtime\hooks'
        $hooksDirNeedle = [IO.Path]::GetFullPath($hooksDir).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        $untrusted = @(Get-UntrustedCodexHookKeys $codexHooksEntry.path $codexConfigToml { param($cmd) $cmd.IndexOf($hooksDirNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($untrusted.Count -gt 0) {
            Add-Warn 'codex hook trust' "$($untrusted.Count) agent-workflow hook(s) are installed but not yet trusted by Codex; they will not run until approved in an interactive session: $($untrusted -join '; ')"
        } else {
            Add-Pass 'codex hook trust'
        }
    }
}

if ($failures -gt 0) { exit 1 }
exit 0
