[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [switch]$Ensure,
    [string[]]$RegisterWorktree = @(),
    [string]$RosterFor = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-StableId([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
    } finally {
        $sha.Dispose()
    }
}

function Normalize-Path([string]$Value) {
    return ([IO.Path]::GetFullPath($Value).TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant())
}

# project.json is read-modify-write. Coordinators register every worker worktree up front
# in one call, but hold an exclusive lock anyway so a stray concurrent write cannot lose data.
function Invoke-WithProjectLock([string]$LockPath, [scriptblock]$Action) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
    $stream = $null
    for ($attempt = 0; $attempt -lt 200; $attempt++) {
        try { $stream = [IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None'); break }
        catch [IO.IOException] { Start-Sleep -Milliseconds 25 }
    }
    if (-not $stream) { throw "could not acquire the project lock: $LockPath" }
    try { & $Action } finally { $stream.Dispose() }
}

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$isGit = $false
$root = $resolvedPath
$commonDir = $resolvedPath
$remote = ''
$repoFingerprint = ''

& git -C $resolvedPath rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $isGit = $true
    $root = (& git -C $resolvedPath rev-parse --show-toplevel).Trim()
    $commonRaw = (& git -C $resolvedPath rev-parse --git-common-dir).Trim()
    if ([IO.Path]::IsPathRooted($commonRaw)) {
        $commonDir = [IO.Path]::GetFullPath($commonRaw)
    } else {
        $commonDir = [IO.Path]::GetFullPath((Join-Path $root $commonRaw))
    }
    $remoteOut = & git -C $resolvedPath config --get remote.origin.url 2>$null
    if ($LASTEXITCODE -eq 0 -and $remoteOut) { $remote = ($remoteOut | Select-Object -First 1).Trim() }
    $roots = @(& git -C $resolvedPath rev-list --max-parents=0 HEAD 2>$null | Sort-Object)
    if ($LASTEXITCODE -eq 0 -and $roots.Count -gt 0) { $repoFingerprint = ($roots -join ',').ToLowerInvariant() }
}

$rootNorm = Normalize-Path $root
$commonNorm = Normalize-Path $commonDir
$projectId = Get-StableId ($commonNorm + '|' + $remote.ToLowerInvariant() + '|' + $repoFingerprint)
$worktreeId = Get-StableId $rootNorm
$projectDir = Join-Path $StateRoot "projects\$projectId"
$taskRoot = Join-Path $projectDir 'tasks'
$projectFile = Join-Path $projectDir 'project.json'
$now = (Get-Date).ToString('o')

$registeredWorktrees = @()
if ($RegisterWorktree.Count -gt 0) {
    foreach ($candidate in $RegisterWorktree) {
        $resolvedWorktree = (Resolve-Path -LiteralPath $candidate).Path
        $registeredWorktrees += [pscustomobject]@{ id = (Get-StableId (Normalize-Path $resolvedWorktree)); path = $resolvedWorktree }
    }
}

if ($Ensure -or $registeredWorktrees.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir 'knowledge\entries') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir 'history\tasks') | Out-Null

    Invoke-WithProjectLock (Join-Path $projectDir '.project.lock') {
        if (Test-Path -LiteralPath $projectFile) {
            $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $aliases = @($project.aliases)
            $worktrees = @($project.worktrees)
            $createdAt = $project.created_at
        } else {
            $aliases = @()
            $worktrees = @()
            $createdAt = $now
        }
        if ($aliases -notcontains $root) { $aliases += $root }

        $incoming = @()
        if ($Ensure) { $incoming += [pscustomobject]@{ id = $worktreeId; path = $root } }
        $incoming += $registeredWorktrees
        foreach ($entry in $incoming) {
            $worktrees = @($worktrees | Where-Object { $_.id -ne $entry.id })
            $worktrees += $entry
        }
        if ($worktrees.Count -eq 0) { $worktrees = @([pscustomobject]@{ id = $worktreeId; path = $root }) }

        $projectData = [ordered]@{
            id = $projectId
            canonical_root = $root
            git_common_dir = $commonDir
            remote = $remote
            repo_fingerprint = $repoFingerprint
            aliases = @($aliases | Sort-Object -Unique)
            worktrees = @($worktrees | Sort-Object -Property id)
            created_at = $createdAt
            updated_at = $now
        }
        # -Ensure runs on every task creation and every hook that resolves a project, so an
        # unconditional write would rewrite project.json (and bump updated_at) even when nothing
        # changed. Compare against what is already on disk with updated_at held equal, and only
        # write - and only then advance updated_at - if something actually differs.
        $shouldWrite = $true
        if (Test-Path -LiteralPath $projectFile) {
            $projectData.updated_at = $project.updated_at
            $before = ((Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json) | ConvertTo-Json -Depth 8)
            $after = ($projectData | ConvertTo-Json -Depth 8)
            if ($before -eq $after) { $shouldWrite = $false } else { $projectData.updated_at = $now }
        }
        if ($shouldWrite) { [IO.File]::WriteAllText($projectFile, ($projectData | ConvertTo-Json -Depth 8), $utf8NoBom) }
    }
}

# [ \t]* and ([^\r\n]*), matching check-task.ps1 and orchestrate.ps1 exactly. \s* is greedy ACROSS
# newlines, so an empty field would swallow the line break and return the NEXT line's text as its
# value - e.g. an empty `delivery_status:` reading back as 'subtask_role: worker'.
function Get-Field([string]$Content, [string]$Name) {
    if ($Content -match "(?m)^$([regex]::Escape($Name)):[ \t]*([^\r\n]*)") { return $Matches[1].Trim() }
    return ''
}

# active_tasks stays scoped to the current worktree; the roster is a separate, explicit query
# because worker tasks live in other worktrees and must never leak into the active-task gate.
#
# stopped_tasks is a SEPARATE list on purpose. Widening active_tasks to include paused/blocked
# would break six consumers at once: task-gate.ps1 asserts `status: in_progress` on whatever it
# is handed, close-task.ps1 refuses anything else, and orchestrate.ps1 deliberately relies on a
# non-in_progress coordinator dropping out of active_tasks so the recovery actions stay runnable.
# The Stop hook needs to see these tasks for one reason only - to require a stop_reason - so it
# gets its own field and every existing reader is untouched.
$activeTasks = @()
$stoppedTasks = @()
$roster = @()
if (Test-Path -LiteralPath $taskRoot) {
    foreach ($task in (Get-ChildItem -LiteralPath $taskRoot -Recurse -Filter task.md -File -ErrorAction SilentlyContinue)) {
        # Every field read here is frontmatter, and this loop runs over every task in the project
        # on every hook invocation. Read the head of the file rather than the whole body.
        $content = (Get-Content -LiteralPath $task.FullName -Encoding UTF8 -TotalCount 64 -ErrorAction SilentlyContinue) -join "`n"
        $taskWorktree = Get-Field $content 'worktree_id'
        $status = Get-Field $content 'status'
        if ($taskWorktree -eq $worktreeId -and $status -eq 'in_progress') { $activeTasks += $task.FullName }
        if ($taskWorktree -eq $worktreeId -and @('paused', 'blocked') -contains $status) {
            $stoppedTasks += [pscustomobject]@{
                path = $task.FullName
                status = $status
                stop_reason = (Get-Field $content 'stop_reason')
            }
        }
        if ($RosterFor -and (Get-Field $content 'parent_task_id') -eq $RosterFor) {
            $roster += [pscustomobject]@{
                id = (Get-Field $content 'id')
                path = $task.FullName
                worktree_id = $taskWorktree
                status = $status
                subtask_role = (Get-Field $content 'subtask_role')
                delivery_status = (Get-Field $content 'delivery_status')
            }
        }
    }
}

[pscustomobject]@{
    is_git = $isGit
    project_id = $projectId
    worktree_id = $worktreeId
    root = $root
    git_common_dir = $commonDir
    remote = $remote
    repo_fingerprint = $repoFingerprint
    project_dir = $projectDir
    task_root = $taskRoot
    active_tasks = $activeTasks
    stopped_tasks = @($stoppedTasks | Sort-Object -Property path)
    registered_worktrees = @($registeredWorktrees)
    roster = @($roster | Sort-Object -Property id)
} | ConvertTo-Json -Depth 6
