[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskPath,
    [Parameter(Mandatory)][ValidateSet('Worker', 'Coordinator')][string]$Mode,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow')
)

# Incremental checks for coordinator/worker tasks. The base task rules stay in quality-gate.ps1;
# this script only adds what the orchestration roles require, so a regression here cannot
# change how a plain single task is gated.

$ErrorActionPreference = 'Stop'
$issues = @()

function Get-Section([string]$Content, [string]$Prefix) {
    $escaped = [regex]::Escape($Prefix)
    return [regex]::Match($Content, "(?ms)^## $escaped.*?\r?\n(.*?)(?=^## |\z)").Groups[1].Value.Trim()
}

function Test-Section([string]$Content, [string]$Prefix) {
    $body = Get-Section $Content $Prefix
    return ($body -and $body -notmatch '^<.*>$')
}

function Get-Field([string]$Content, [string]$Name) {
    if ($Content -match "(?m)^$([regex]::Escape($Name)):[ \t]*([^\r\n]*)") { return $Matches[1].Trim() }
    return ''
}

if (-not (Test-Path -LiteralPath $TaskPath -PathType Leaf)) {
    [pscustomobject]@{ valid = $false; issues = @("task not found: $TaskPath"); mode = $Mode } | ConvertTo-Json -Depth 6
    exit 0
}

# Commented-out template sections are not content; strip them the same way the hooks do.
$raw = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
$content = [regex]::Replace($raw, '(?s)<!--.*?-->', '')

$validator = Join-Path $PSScriptRoot 'validate-task.ps1'
if (Test-Path -LiteralPath $validator) {
    $frontmatter = (& $validator -TaskPath $TaskPath | Out-String) | ConvertFrom-Json
    if (-not $frontmatter.valid) { $issues += @($frontmatter.errors) }
}

$role = Get-Field $content 'subtask_role'
if ($role -ne $Mode.ToLowerInvariant()) { $issues += "task subtask_role is '$role', expected '$($Mode.ToLowerInvariant())'" }

if ($Mode -eq 'Worker') {
    # Worker mode is shared by the worker stop gate, Collect and Apply. It must never require
    # delivery metadata: at worker stop time the coordinator has not collected anything yet.
    $status = Get-Field $content 'status'
    if ($status -ne 'done') { $issues += "worker task must be done before collection, current status is '$status'" }

    foreach ($section in @('Parent task', 'File ownership', 'Impact surface', 'Execution path and regression evidence')) {
        if (-not (Test-Section $content $section)) { $issues += "missing or empty section: $section" }
    }

    # Identity contract: a worker cannot be allowed to point parent_task_id at a task that
    # merely matches the id pattern - it must actually resolve to a real coordinator in the
    # same project, and the worker's own worktree_id/id must match what Init registered. Without
    # this, a worker could silently detach itself from any coordinator's roster (parent_task_id
    # pointing nowhere real) or masquerade as belonging to an unrelated project.
    $workerTaskId = Get-Field $content 'id'
    $workerProjectId = Get-Field $content 'project_id'
    $workerWorktreeId = Get-Field $content 'worktree_id'
    $parentTaskId = Get-Field $content 'parent_task_id'
    if ($parentTaskId -and $workerProjectId) {
        $parentTaskFile = Join-Path $StateRoot "projects\$workerProjectId\tasks\$parentTaskId\task.md"
        if (-not (Test-Path -LiteralPath $parentTaskFile -PathType Leaf)) {
            $issues += "parent_task_id '$parentTaskId' does not resolve to a task in project '$workerProjectId'"
        } else {
            $parentContent = [regex]::Replace((Get-Content -LiteralPath $parentTaskFile -Raw -Encoding UTF8), '(?s)<!--.*?-->', '')
            if ((Get-Field $parentContent 'subtask_role') -ne 'coordinator') {
                $issues += "parent_task_id '$parentTaskId' does not point to a coordinator task"
            }
        }
    }
    if ($workerProjectId -and $workerWorktreeId -and $workerTaskId) {
        $projectFile = Join-Path $StateRoot "projects\$workerProjectId\project.json"
        if (Test-Path -LiteralPath $projectFile) {
            $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $entry = @($project.worktrees | Where-Object { $_.id -eq $workerWorktreeId })
            if ($entry.Count -ne 1) {
                $issues += "worktree_id '$workerWorktreeId' is not a registered worktree"
            } elseif ((Split-Path -Leaf $entry[0].path) -ne $workerTaskId) {
                $issues += "task id '$workerTaskId' does not match its registered worktree directory name '$(Split-Path -Leaf $entry[0].path)'"
            }
        }
    }

    $review = Get-Section $content 'Reviewer result'
    if (-not $review -or $review -notmatch '(?mi)^[ \t]*-[ \t]*result:[ \t]*PASS[ \t]*\r?$') { $issues += 'Reviewer result is missing or not passed' }
    foreach ($dimension in @('Architecture consistency','Code quality and conventions','Data consistency','Security','Risk and compatibility','Performance','Flow and impact completeness')) {
        $allowedStatus = if (@('Data consistency','Security','Performance') -contains $dimension) { '(?:PASS|N/A)' } else { 'PASS' }
        $pattern = '(?mi)^[ \t]*-[ \t]*' + [regex]::Escape($dimension) + ':[ \t]*' + $allowedStatus + '(?:[ \t]+.*)?[ \t]*\r?$'
        if ($review -notmatch $pattern) { $issues += "Reviewer result missing or not passed dimension: $dimension" }
    }

    $verify = Get-Section $content 'Verifier result'
    if (-not $verify -or $verify -notmatch '(?mi)^[ \t]*-[ \t]*PASS[ \t]*\r?$') { $issues += 'Verifier result is missing or not passed' }
} else {
    $integration = Get-Field $content 'integration_status'
    $taskId = Get-Field $content 'id'
    $projectId = Get-Field $content 'project_id'
    $coordinatorWorktreeId = Get-Field $content 'worktree_id'

    # The task directory itself (Split-Path -Parent $TaskPath) is not a git repo, so it cannot
    # be handed to project-resolver.ps1 directly - that would resolve a bogus non-git project_id
    # instead of the coordinator's real one. Look up the coordinator's actual worktree path from
    # project.json (populated by orchestrate.ps1 Init/-RegisterWorktree) and resolve from there,
    # the same way orchestrate.ps1 itself does.
    $resolver = Join-Path $PSScriptRoot 'project-resolver.ps1'
    $roster = @()
    if ($taskId -and $projectId -and (Test-Path -LiteralPath $resolver)) {
        $projectFile = Join-Path $StateRoot "projects\$projectId\project.json"
        $coordinatorRoot = ''
        if (Test-Path -LiteralPath $projectFile) {
            $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $entry = @($project.worktrees | Where-Object { $_.id -eq $coordinatorWorktreeId })
            if ($entry.Count -eq 1) { $coordinatorRoot = $entry[0].path }
        }
        if ($coordinatorRoot) {
            $resolved = (& $resolver -Path $coordinatorRoot -StateRoot $StateRoot -RosterFor $taskId | Out-String) | ConvertFrom-Json
            $roster = @($resolved.roster)
        }
    }
    # Terminal for a worker means done (delivered) or superseded (its scope was cancelled by the
    # user). blocked is NOT terminal: a blocked worker is fixed forward in its own worktree, so
    # the coordinator is still waiting on it and must not be able to close over it.
    $pendingWorkers = @($roster | Where-Object { @('done','superseded') -notcontains $_.status })

    if ($integration -eq 'pending' -and $pendingWorkers.Count -gt 0) {
        # Waiting is a legitimate stop point: Manual mode requires the coordinator to end its turn
        # while workers run. Everything that only exists after integration is skipped here.
        [pscustomobject]@{
            valid = ($issues.Count -eq 0)
            issues = @($issues)
            mode = $Mode
            waiting_for = $pendingWorkers.Count
            note = "waiting for $($pendingWorkers.Count) worker(s)"
        } | ConvertTo-Json -Depth 6
        exit 0
    }

    if ($pendingWorkers.Count -gt 0) { $issues += "$($pendingWorkers.Count) worker(s) are not in a terminal state" }
    # merged is a terminal delivery state: the coordinator hand-merged it after an apply conflict.
    $unresolved = @($roster | Where-Object { @('applied','merged','rejected','skipped') -notcontains $_.delivery_status })
    if ($unresolved.Count -gt 0) { $issues += "$($unresolved.Count) delivery/deliveries are still unresolved" }
    if ($integration -ne 'applied') { $issues += "integration_status must be 'applied' before completion, current value is '$integration'" }

    foreach ($section in @('Decomposition plan', 'Worker results', 'Delivery log', 'Integration verification')) {
        if (-not (Test-Section $content $section)) { $issues += "missing or empty section: $section" }
    }
}

[pscustomobject]@{
    valid = ($issues.Count -eq 0)
    issues = @($issues)
    mode = $Mode
} | ConvertTo-Json -Depth 6
