# agent-workflow v4 - validate only the current worktree's in-progress task.
#
# This hook owns the Stop-event plumbing (payload, cwd, active-task resolution) and nothing
# else: every rule about whether a task is complete lives in scripts/task-gate.ps1, shared with
# scripts/close-task.ps1. Before that split, "status: done" was the one task edit no gate
# inspected, because this hook only ever looks at in_progress tasks.
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Read-HookInput {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
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

    # paused/blocked used to be a free exit: flipping the status made the task vanish from
    # active_tasks, and with it every completion check, without recording why. That is the one
    # escape hatch the whole gate system had, and it cost nothing to take. It stays an escape
    # hatch - stopping mid-way is legitimate - but it now has to say what it is waiting for.
    # Checked before the active-task early exit, because "no active task" is exactly the state a
    # bare `status: paused` produces.
    $stopped = @($resolved.stopped_tasks)
    $unexplained = @($stopped | Where-Object {
        $reason = [string]$_.stop_reason
        (-not $reason) -or ($reason -match '^<.*>$')
    })
    if ($unexplained.Count -gt 0) {
        $detail = ($unexplained | ForEach-Object { "$($_.path) [$($_.status)]" }) -join ', '
        $reason = "quality-gate: $($unexplained.Count) task(s) are $($unexplained[0].status)/blocked with no 'stop_reason:' in frontmatter: $detail. Add 'stop_reason: <what is needed to resume>', or set the task to superseded if it is abandoned."
        Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
        exit 0
    }

    $active = @($resolved.active_tasks)
    if ($active.Count -eq 0) { exit 0 }

    if ($active.Count -gt 1) {
        $reason = "quality-gate: worktree $($resolved.worktree_id) has multiple in_progress tasks. Pause, block, finish, or supersede all but one: $($active -join ', ')"
        Write-Output (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
        exit 0
    }

    $taskPath = $active[0]
    $gate = Join-Path $PSScriptRoot '..\scripts\task-gate.ps1'
    if (-not (Test-Path -LiteralPath $gate)) { exit 0 }
    $result = (& $gate -TaskPath $taskPath -Cwd $cwd -WorktreeId $resolved.worktree_id -Mode Stop | Out-String) | ConvertFrom-Json
    $issues = @($result.issues)

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
