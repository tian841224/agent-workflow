# agent-workflow v4 - surface, but never block on, the current worktree's task state.
#
# This hook owns the Stop-event plumbing (payload, cwd, active-task resolution) and nothing
# else: every rule about whether a task is complete lives in scripts/task-gate.ps1, shared with
# scripts/close-task.ps1.
#
# Deliberately never returns decision:block. An unfinished in_progress task, or an unexplained
# paused/blocked one, belongs to whichever turn actually created or is continuing it - not to
# every later turn that merely shares the same worktree, including an unrelated question with no
# connection to that task. This hook only nudges - once per session per task, via systemMessage -
# so a dangling task still surfaces instead of going completely unnoticed.
#
# hooks/impact-guard.ps1 is the independent lock: it denies writing `status: done` directly, so a
# task cannot be silently marked finished without going through scripts/close-task.ps1, which
# reruns task-gate.ps1 -Mode Close and enforces completion for real.
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

    $notes = @()
    $noteKeys = @()

    # paused/blocked with no stop_reason: nothing records why work stopped, worth a nudge.
    $stopped = @($resolved.stopped_tasks)
    $unexplained = @($stopped | Where-Object {
        $reason = [string]$_.stop_reason
        (-not $reason) -or ($reason -match '^<.*>$')
    })
    if ($unexplained.Count -gt 0) {
        $detail = ($unexplained | ForEach-Object { "$($_.path) [$($_.status)]" }) -join ', '
        $notes += "$($unexplained.Count) task(s) are $($unexplained[0].status)/blocked with no 'stop_reason:' in frontmatter: $detail. Add 'stop_reason: <what is needed to resume>', or set the task to superseded if it is abandoned."
        $noteKeys += @($unexplained | ForEach-Object { "$($_.path)|$($_.status)" })
    }

    $active = @($resolved.active_tasks)
    if ($active.Count -gt 1) {
        $notes += "worktree $($resolved.worktree_id) has multiple in_progress tasks: $($active -join ', ')"
        $noteKeys += "multiple:$($resolved.worktree_id)"
    } elseif ($active.Count -eq 1) {
        $taskPath = $active[0]
        $gate = Join-Path $PSScriptRoot '..\scripts\task-gate.ps1'
        if (Test-Path -LiteralPath $gate) {
            $result = (& $gate -TaskPath $taskPath -Cwd $cwd -WorktreeId $resolved.worktree_id -Mode Stop | Out-String) | ConvertFrom-Json
            $issues = @($result.issues)
            if ($issues.Count -gt 0) {
                $notes += "$($taskPath) is in_progress and incomplete - $($issues -join ' | ')"
                $noteKeys += "task:$taskPath"
            }
        }
    }

    if ($notes.Count -eq 0) { exit 0 }

    # Once per session per task/worktree-state, not every turn: a dangling task nobody is
    # touching this session should not repeat the same notice on every single Stop. session_id
    # absent (every existing test fixture, and any platform payload that omits it) skips the
    # dedupe entirely rather than guessing - always notify in that case.
    $sessionId = [string]$payload.session_id
    if ($sessionId) {
        $noticeDir = Join-Path $resolved.project_dir '.stop-notices'
        $noticePath = Join-Path $noticeDir "$sessionId.json"
        $alreadyNotified = @()
        if (Test-Path -LiteralPath $noticePath) {
            try { $alreadyNotified = @((Get-Content -LiteralPath $noticePath -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { }
        }
        $newKeys = @($noteKeys | Where-Object { $alreadyNotified -notcontains $_ })
        if ($newKeys.Count -eq 0) { exit 0 }
        New-Item -ItemType Directory -Force -Path $noticeDir | Out-Null
        [IO.File]::WriteAllText($noticePath, (@($alreadyNotified + $newKeys) | ConvertTo-Json -Compress), $utf8NoBom)
    }

    $message = "agent-workflow: this worktree has unfinished task state - $($notes -join ' | '). Resolve it, or set status to paused/blocked with a stop_reason, whenever convenient."
    Write-Output (@{ continue = $true; systemMessage = $message } | ConvertTo-Json -Compress)
} catch {
    # Fail-open, same as every other hook in this file: a broken guard must not stop work. Still
    # leave a trace - a guard that fails silently is indistinguishable from one that passed.
    if ($raw) {
        try {
            $logDir = Join-Path $env:USERPROFILE '.agent-workflow\logs'
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            Add-Content -LiteralPath (Join-Path $logDir 'hook-errors.log') -Value ((Get-Date).ToString('s') + "`tquality-gate`t" + $_.Exception.Message) -Encoding UTF8
        } catch { }
    }
}
exit 0
