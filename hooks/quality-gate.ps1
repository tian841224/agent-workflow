# agent-workflow v4 - validate only the current worktree's in-progress task.
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

function Add-MissingSection([string]$Content, [string]$Prefix, [ref]$Issues) {
    $body = Get-Section $Content $Prefix
    if (-not $body -or $body -match '^<.*>$') { $Issues.Value += "missing or empty section: $Prefix" }
}

try {
    $raw = Read-HookInput
    $payload = $raw | ConvertFrom-Json
    if ($payload.stop_hook_active) { exit 0 }

    $cwd = if ($payload.workspacePaths) { @($payload.workspacePaths)[0] } else { $payload.cwd }
    if (-not $cwd) { exit 0 }

    $resolver = Join-Path $PSScriptRoot '..\scripts\project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolver)) { exit 0 }
    $resolved = (& $resolver -Path $cwd | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -eq 0) { exit 0 }

    if ($active.Count -gt 1) {
        $reason = "quality-gate: worktree $($resolved.worktree_id) has multiple in_progress tasks. Pause, block, finish, or supersede all but one: $($active -join ', ')"
        Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
        exit 0
    }

    $taskPath = $active[0]
    $rawContent = Get-Content -LiteralPath $taskPath -Raw -Encoding UTF8
    $content = [regex]::Replace($rawContent, '(?s)<!--.*?-->', '')
    $issues = @()
    $validator = Join-Path $PSScriptRoot '..\scripts\validate-task.ps1'
    $frontmatter = (& $validator -TaskPath $taskPath | Out-String) | ConvertFrom-Json
    if (-not $frontmatter.valid) { $issues += @($frontmatter.errors) }
    if ($frontmatter.data.worktree_id -ne $resolved.worktree_id) { $issues += 'task worktree_id does not match the current worktree' }
    foreach ($field in @('id','project_id','worktree_id','status','code_change','risk_flags','created_at','updated_at')) {
        if ($content -notmatch "(?m)^${field}:[ \t]*\S+") { $issues += "missing frontmatter field: $field" }
    }
    if ($content -notmatch '(?m)^status:[ \t]*in_progress[ \t]*$') { $issues += 'active task status is invalid' }
    $unchecked = [regex]::Matches($content, '(?m)^\s*-\s*\[ \]\s+(.+)$') |
        ForEach-Object { $_.Groups[1].Value.Trim() }
    if ($unchecked) { $issues += "unchecked completion items: $($unchecked -join '; ')" }

    foreach ($section in @('Goal','Scope','Completion criteria','Validation results')) {
        Add-MissingSection $content $section ([ref]$issues)
    }
    $validation = Get-Section $content 'Validation results'
    $preReview = [regex]::Match($validation, '(?mi)^\s*-\s*pre-review:\s*(PASS|SKIP)\s*$')
    if (-not $preReview.Success) {
        $issues += 'pre-review result must be PASS or SKIP'
    } elseif ($preReview.Groups[1].Value -eq 'SKIP') {
        $skipReason = [regex]::Match($validation, '(?mi)^\s*-\s*skip reason:\s*(.+)$').Groups[1].Value.Trim()
        if (-not $skipReason -or $skipReason -match '^<.*>$') { $issues += 'SKIP pre-review requires a reason' }
    }

    $riskLine = if ($content -match '(?m)^risk_flags:[ \t]*\[(.*?)\][ \t]*$') { $Matches[1] } else { '' }
    $flags = @($riskLine -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $allowedFlags = @('behavior_change','ui','external_input','data_write','security','refactor','contract','schema','financial','authorization','cross_feature','migration','irreversible','unclear_requirements')
    foreach ($flag in $flags) { if ($allowedFlags -notcontains $flag) { $issues += "unknown risk flag: $flag" } }
    $freezeFlags = @('contract','schema','financial','authorization','cross_feature','migration','irreversible','unclear_requirements')
    $needsFreeze = @($flags | Where-Object { $freezeFlags -contains $_ }).Count -gt 0
    $needsReviewer = $frontmatter.code_change -eq $true
    $needsVerifier = $frontmatter.code_change -eq $true

    if ($needsFreeze) {
        if ($content -notmatch '(?m)^frozen_at:[ \t]*\S+[ \t]*$') { $issues += 'freeze-required task has no frozen_at' }
        foreach ($section in @('Non-goals and compatibility','Current state and impact','Decision and tradeoffs','Boundary and error paths','User confirmation')) {
            if ($content -notmatch "(?m)^## $([regex]::Escape($section))") { $issues += "missing section: $section" }
        }
    }
    if ($needsFreeze -or ($flags -contains 'behavior_change') -or ($flags -contains 'ui')) {
        Add-MissingSection $content 'Acceptance cases' ([ref]$issues)
    }
    if (@($flags | Where-Object { @('contract','schema','data_write','financial','migration') -contains $_ }).Count -gt 0) {
        Add-MissingSection $content 'Contract and data impact' ([ref]$issues)
    }
    if (@($flags | Where-Object { @('cross_feature','migration','irreversible') -contains $_ }).Count -gt 0) {
        Add-MissingSection $content 'Implementation sequence' ([ref]$issues)
    }
    if ($flags -contains 'ui') {
        Add-MissingSection $content 'Browser verification' ([ref]$issues)
    }
    if ($flags -contains 'refactor') {
        Add-MissingSection $content 'Behavior invariants and before-after evidence' ([ref]$issues)
    }
    if ($needsReviewer) {
        Add-MissingSection $content 'Impact surface' ([ref]$issues)
        Add-MissingSection $content 'Execution path and regression evidence' ([ref]$issues)
        $review = Get-Section $content 'Reviewer result'
        if (-not $review -or $review -match '^<.*>$' -or $review -notmatch '(?mi)^[ \t]*-[ \t]*result:[ \t]*PASS[ \t]*\r?$') { $issues += 'Reviewer result is missing or not passed' }
        foreach ($dimension in @('Architecture consistency','Code quality and conventions','Data consistency','Security','Risk and compatibility','Performance','Flow and impact completeness')) {
            $allowedStatus = if (@('Data consistency','Security','Performance') -contains $dimension) { '(?:PASS|N/A)' } else { 'PASS' }
            $dimensionPattern = '(?mi)^[ \t]*-[ \t]*' + [regex]::Escape($dimension) + ':[ \t]*' + $allowedStatus + '(?:[ \t]+.*)?[ \t]*\r?$'
            if ($review -notmatch $dimensionPattern) { $issues += "Reviewer result missing or not passed dimension: $dimension" }
        }
    }
    if ($needsVerifier) {
        $verify = Get-Section $content 'Verifier result'
        if (-not $verify -or $verify -match '^<.*>$' -or $verify -notmatch '(?mi)^[ \t]*-[ \t]*PASS[ \t]*\r?$') { $issues += 'Verifier result is missing or not passed' }
    }

    if ($issues.Count -gt 0) {
        $reason = "quality-gate: active task $taskPath is incomplete - $($issues -join ' | '). Finish it or set status to paused/blocked before stopping."
        Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
    }
} catch {
    if ($raw) {
        $reason = "quality-gate failed to inspect the active task: $($_.Exception.Message)"
        Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
    }
}
exit 0
