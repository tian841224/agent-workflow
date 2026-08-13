[CmdletBinding()]
param(
    [string]$TaskPath,
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow')
)

# The only sanctioned way to move a task to `done`.
#
# The Stop hook only ever inspects `status: in_progress` tasks, so writing `done` used to be the
# single task edit nothing checked - and tasks did ship that way, with every completion
# criterion unticked and the role sections holding placeholder text. impact-guard.ps1 now denies
# a direct `status: done` write and points here; this script runs the same rules the Stop hook
# runs (scripts/task-gate.ps1, -Mode Close) and only then rewrites the frontmatter.

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Fail([string]$Message) { Write-Error $Message; exit 1 }

$resolverPath = Join-Path $PSScriptRoot 'project-resolver.ps1'
$gatePath = Join-Path $PSScriptRoot 'task-gate.ps1'
if (-not (Test-Path -LiteralPath $gatePath)) { Fail "task-gate.ps1 not found next to close-task.ps1: $gatePath" }

$worktreeId = ''
$cwd = $Path
if (-not $TaskPath) {
    if (-not (Test-Path -LiteralPath $resolverPath)) { Fail "project-resolver.ps1 not found: $resolverPath" }
    $resolved = (& $resolverPath -Path $Path -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -eq 0) { Fail 'no in_progress task in this worktree; nothing to close.' }
    if ($active.Count -gt 1) { Fail "this worktree has multiple in_progress tasks; close them one at a time: $($active -join ', ')" }
    $TaskPath = $active[0]
    $worktreeId = $resolved.worktree_id
}
if (-not (Test-Path -LiteralPath $TaskPath)) { Fail "task file not found: $TaskPath" }

# Hashtable splatting, not array: array splatting binds positionally, so a leading "-TaskPath"
# string would be consumed as the value of the first parameter instead of naming it.
$gateArgs = @{ TaskPath = $TaskPath; Cwd = $cwd; Mode = 'Close' }
if ($worktreeId) { $gateArgs['WorktreeId'] = $worktreeId }
$result = (& $gatePath @gateArgs | Out-String) | ConvertFrom-Json
$issues = @($result.issues)

if ($issues.Count -gt 0) {
    Write-Output "close-task: $TaskPath is not ready to close."
    foreach ($issue in $issues) { Write-Output "  - $issue" }
    Write-Output 'Fix the items above, or set status to paused/blocked if the work is stopping here.'
    exit 1
}

$raw = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
# \r?$ throughout: task files written by orchestrate.ps1 are CRLF, and .NET's $ in multiline
# mode matches only before a bare \n. Without it the replace is a silent no-op - a failure mode
# this repo has already shipped once, in Set-Frontmatter.
$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$updated = [regex]::Replace($raw, '(?m)^(status:)[ \t]*in_progress[ \t]*(\r?)$', '${1} done${2}')
if ($updated -eq $raw) { Fail "could not find a 'status: in_progress' line to update in $TaskPath" }
$updated = [regex]::Replace($updated, '(?m)^(updated_at:)[ \t]*\S+[ \t]*(\r?)$', "`${1} $stamp`${2}")
[IO.File]::WriteAllText($TaskPath, $updated, $utf8NoBom)

Write-Output "close-task: $TaskPath is now done."
if ($result.waived) {
    # A waiver is a user decision that skipped the independent roles. It has to stay visible at
    # the moment of closing, not just sit in frontmatter nobody re-reads.
    Write-Output "close-task: WARNING - the independent roles were waived: $($result.waived)"
}
exit 0
