[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [switch]$Ensure
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

if ($Ensure) {
    New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir 'knowledge\entries') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir 'history\tasks') | Out-Null

    if (Test-Path -LiteralPath $projectFile) {
        $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $aliases = @($project.aliases)
        if ($aliases -notcontains $root) { $aliases += $root }
        $worktrees = @($project.worktrees | Where-Object { $_.id -ne $worktreeId })
        $worktrees += [pscustomobject]@{ id = $worktreeId; path = $root }
        $createdAt = $project.created_at
    } else {
        $aliases = @($root)
        $worktrees = @([pscustomobject]@{ id = $worktreeId; path = $root })
        $createdAt = $now
    }

    $projectData = [ordered]@{
        id = $projectId
        canonical_root = $root
        git_common_dir = $commonDir
        remote = $remote
        repo_fingerprint = $repoFingerprint
        aliases = @($aliases | Sort-Object -Unique)
        worktrees = @($worktrees)
        created_at = $createdAt
        updated_at = $now
    }
    [IO.File]::WriteAllText($projectFile, ($projectData | ConvertTo-Json -Depth 8), $utf8NoBom)
}

$activeTasks = @()
if (Test-Path -LiteralPath $taskRoot) {
    foreach ($task in (Get-ChildItem -LiteralPath $taskRoot -Recurse -Filter task.md -File -ErrorAction SilentlyContinue)) {
        $content = Get-Content -LiteralPath $task.FullName -Raw -Encoding UTF8
        $taskWorktree = if ($content -match '(?m)^worktree_id:\s*([^\r\n]+)') { $Matches[1].Trim() } else { '' }
        $status = if ($content -match '(?m)^status:\s*([^\r\n]+)') { $Matches[1].Trim() } else { '' }
        if ($taskWorktree -eq $worktreeId -and $status -eq 'in_progress') { $activeTasks += $task.FullName }
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
} | ConvertTo-Json -Depth 6
