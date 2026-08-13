[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Reason,
    [switch]$ConfirmedByUser,
    [string]$TaskPath,
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow')
)

# The only sanctioned way to write `roles_waived` into a task.
#
# roles_waived is the widest hole in the gate system: one frontmatter line switches off Reviewer,
# Adversarial, Verifier and the independence check together, and everything else in task-gate.ps1
# keeps passing. The rule that only the user may authorise it lived entirely in prose
# (SKILL.md, AGENTS.md, README.md) - which is exactly the kind of rule an agent that is about to
# skip the roles is already not following. impact-guard.ps1 now denies a direct edit and points
# here, mirroring what close-task.ps1 does for `status: done`.
#
# This is a collaborative guard, not a sandbox: a shell redirect still writes the file, and
# orchestration.md's known limitations already say so. What it buys is that waiving the roles
# becomes a deliberate, named act with the user's stated reason attached, instead of a line that
# appears in a diff nobody reads.

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Fail([string]$Message) { Write-Error $Message; exit 1 }

if (-not $ConfirmedByUser) {
    Fail 'waive-roles requires -ConfirmedByUser. Waiving the independent roles is the user''s decision: ask them explicitly, then pass their reason with -Reason and add -ConfirmedByUser. If they have not asked for this, run the roles, or set the task to blocked and record the next step.'
}

$trimmedReason = $Reason.Trim()
if (-not $trimmedReason) { Fail 'waive-roles needs a non-empty -Reason.' }
if ($trimmedReason -match '^<.*>$') { Fail 'waive-roles needs an actual reason, not a placeholder.' }
# The reason lands in single-line YAML frontmatter and is echoed by close-task.ps1.
if ($trimmedReason -match '[\r\n]') { Fail 'waive-roles -Reason must be a single line.' }

$resolverPath = Join-Path $PSScriptRoot 'project-resolver.ps1'
if (-not $TaskPath) {
    if (-not (Test-Path -LiteralPath $resolverPath)) { Fail "project-resolver.ps1 not found: $resolverPath" }
    $resolved = (& $resolverPath -Path $Path -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -eq 0) { Fail 'no in_progress task in this worktree; nothing to waive.' }
    if ($active.Count -gt 1) { Fail "this worktree has multiple in_progress tasks; name one with -TaskPath: $($active -join ', ')" }
    $TaskPath = $active[0]
}
if (-not (Test-Path -LiteralPath $TaskPath)) { Fail "task file not found: $TaskPath" }

$raw = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
if ($raw -match '(?m)^roles_waived:[ \t]*(\S.*?)[ \t]*\r?$') {
    Fail "$TaskPath already has roles_waived: $($Matches[1].Trim())"
}

# \r?$ throughout: orchestrate.ps1 writes task files with CRLF and .NET's $ in multiline mode
# matches only before a bare \n. Without it the anchor silently fails to match on those files -
# the same trap close-task.ps1 documents.
$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$anchor = [regex]::Match($raw, '(?m)^updated_at:[ \t]*\S+[ \t]*\r?$')
if (-not $anchor.Success) { Fail "could not find an 'updated_at:' line to anchor the waiver in $TaskPath" }

$eol = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
$updated = $raw.Insert($anchor.Index + $anchor.Length, "${eol}roles_waived: $trimmedReason")
$updated = [regex]::Replace($updated, '(?m)^(updated_at:)[ \t]*\S+[ \t]*(\r?)$', "`${1} $stamp`${2}")
[IO.File]::WriteAllText($TaskPath, $updated, $utf8NoBom)

Write-Output "waive-roles: recorded roles_waived in $TaskPath"
Write-Output "waive-roles: reason - $trimmedReason"
Write-Output 'waive-roles: Reviewer, Adversarial and Verifier are now skipped for this task. Completion criteria, pre-review, Impact surface, Project docs, mutation check and the retrospective all still apply.'
exit 0
