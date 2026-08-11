# agent-workflow v4 - PreToolUse guard: require the task impact surface before editing code.
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Read-HookInput {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-Section([string]$Content, [string]$Prefix) {
    $escaped = [regex]::Escape($Prefix)
    return [regex]::Match($Content, "(?ms)^## $escaped.*?\r?\n(.*?)(?=^## |\z)").Groups[1].Value.Trim()
}

function Resolve-FullPath([string]$Path) {
    try { return [IO.Path]::GetFullPath($Path) } catch { return $Path }
}

# Codex apply_patch is freeform: the paths only exist in the patch headers.
function Get-PatchPath([string]$Text) {
    $found = @()
    foreach ($match in [regex]::Matches($Text, '(?m)^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$')) { $found += $match.Groups[1].Value }
    foreach ($match in [regex]::Matches($Text, '(?m)^\*\*\*\s+Move to:\s*(.+?)\s*$')) { $found += $match.Groups[1].Value }
    return $found
}

try {
    $raw = Read-HookInput
    $payload = $raw | ConvertFrom-Json
    $isAntigravity = $null -ne $payload.toolCall

    # Every early exit below releases the edit; the expensive project resolve runs last.
    $cwd = if ($payload.workspacePaths) { @($payload.workspacePaths)[0] } else { $payload.cwd }
    if (-not $cwd) { exit 0 }
    $cwd = Resolve-FullPath $cwd

    $targets = @()
    if ($isAntigravity) {
        $toolArgs = $payload.toolCall.args
        if ($toolArgs) {
            foreach ($key in @('TargetFile','AbsolutePath','file_path','path')) {
                if ($toolArgs.PSObject.Properties[$key] -and $toolArgs.$key) { $targets += [string]$toolArgs.$key; break }
            }
        }
    } else {
        $toolInput = $payload.tool_input
        if ($toolInput -is [string]) { $targets += Get-PatchPath $toolInput }
        elseif ($toolInput) {
            if ($toolInput.file_path) { $targets += [string]$toolInput.file_path }
            elseif ($toolInput.input -is [string]) { $targets += Get-PatchPath ([string]$toolInput.input) }
        }
    }
    if (-not $targets) { exit 0 }

    # Never gate the task file itself, or the agent could not write the impact surface at all.
    $stateRoot = Resolve-FullPath (Join-Path $env:USERPROFILE '.agent-workflow')
    $gated = @()
    foreach ($candidate in $targets) {
        $full = if ([IO.Path]::IsPathRooted($candidate)) { Resolve-FullPath $candidate } else { Resolve-FullPath (Join-Path $cwd $candidate) }
        if ($full.StartsWith($stateRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not $full.StartsWith($cwd, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $gated += $full
    }
    if (-not $gated) { exit 0 }

    $resolver = Join-Path $PSScriptRoot '..\scripts\project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolver)) { exit 0 }
    $resolved = (& $resolver -Path $cwd | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -ne 1) { exit 0 }

    $taskPath = $active[0]
    if (-not (Test-Path -LiteralPath $taskPath)) { exit 0 }
    $content = [regex]::Replace((Get-Content -LiteralPath $taskPath -Raw -Encoding UTF8), '(?s)<!--.*?-->', '')
    if ($content -notmatch '(?m)^code_change:[ \t]*true[ \t]*$') { exit 0 }

    # Stricter than quality-gate: an untouched <placeholder> template counts as unfilled.
    $impact = Get-Section $content 'Impact surface'
    if ($impact -and $impact -notmatch '<[^>]*>') { exit 0 }

    $reason = "impact-guard: fill '## Impact surface' in $taskPath before editing code (callers / entrypoints / shared state / unverified nodes)."
    $out = if ($isAntigravity) { @{ decision = 'deny'; reason = $reason } } else { @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } }
    Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
} catch { }
exit 0
