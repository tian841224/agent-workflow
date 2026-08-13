[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Record', 'List', 'Resolve')][string]$Action,
    [string]$TaskPath,
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [string]$ProposedChange,
    [string]$Id,
    [string]$MissCategory,
    [ValidateSet('open', 'applied', 'rejected')][string]$Status,
    [string]$Note
)

# The cross-project record of "the framework let this through".
#
# Every other rule in this repo was added by hand after somebody remembered an incident - the
# comments in git-guard.ps1, impact-guard.ps1 and close-task.ps1 are what that looks like. A fix
# is almost always made in some other repository, so the finding cannot be applied where it is
# discovered; it is written here instead, and picked up next time work happens on the framework.
#
# Recording is deliberately not the same as acting. A single miss is a story; the same
# miss_category twice is evidence, and only then does this report escalate = true. Adding a rule
# to v4 for every individual bug is how the previous iteration got heavy enough to need cutting
# back (commit f9394a7 removed a whole scheduled-review mechanism for that reason).
#
# Output is always a single JSON value: an object with `ok` for Record/Resolve, or an array of
# findings for List (an object with ok:false when the store cannot be read).

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Write-Result($Value) {
    Write-Output ($Value | ConvertTo-Json -Depth 6)
}

function Write-Failure([string]$Message) {
    Write-Result ([pscustomobject]@{ ok = $false; error = $Message })
    exit 1
}

function Get-Field([string]$Section, [string]$Name) {
    return [regex]::Match($Section, "(?mi)^[ \t]*-[ \t]*$([regex]::Escape($Name)):[ \t]*(.+?)[ \t]*\r?$").Groups[1].Value.Trim()
}

$schemaPath = Join-Path $PSScriptRoot '..\schemas\retro.schema.json'
if (-not (Test-Path -LiteralPath $schemaPath)) { Write-Failure "retro schema not found: $schemaPath" }
$schema = Get-Content -LiteralPath $schemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
$missCategories = @($schema.properties.miss_category.enum)
$gapRequired = @($schema.x_agent_workflow.gap_required)
$threshold = [int]$schema.x_agent_workflow.escalate_threshold

$retroRoot = Join-Path $StateRoot 'retro'
$findingsRoot = Join-Path $retroRoot 'findings'
$indexPath = Join-Path $retroRoot 'index.json'

# A store that cannot be parsed is never rebuilt from scratch: the occurrence counts are the only
# state that makes escalation mean anything, and silently starting from zero would hide exactly
# the repeat this file exists to detect.
function Read-Index {
    if (-not (Test-Path -LiteralPath $indexPath)) {
        return [pscustomobject]@{ schema_version = 1; updated_at = $null; entries = @() }
    }
    $raw = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        Write-Failure "retro index is unreadable, refusing to reset the occurrence counts: $indexPath ($($_.Exception.Message))"
    }
    if ($null -eq $parsed.entries) { Write-Failure "retro index has no entries array: $indexPath" }
    return $parsed
}

function Save-Index($Index, $Entries) {
    New-Item -ItemType Directory -Force -Path $retroRoot | Out-Null
    $Index.entries = @($Entries)
    $Index.updated_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    [IO.File]::WriteAllText($indexPath, ($Index | ConvertTo-Json -Depth 6), $utf8NoBom)
}

$index = Read-Index
$entries = @($index.entries)

if ($Action -eq 'List') {
    $results = $entries
    if ($Status) { $results = @($results | Where-Object { $_.status -eq $Status }) }
    if ($MissCategory) { $results = @($results | Where-Object { $_.miss_category -eq $MissCategory }) }
    # Newest first: the useful question is almost always "what came up recently".
    Write-Result (@($results | Sort-Object -Property created_at -Descending))
    exit 0
}

if ($Action -eq 'Resolve') {
    if (-not $Id) { Write-Failure 'Resolve needs -Id' }
    if (-not $Status -or $Status -eq 'open') { Write-Failure 'Resolve needs -Status applied or rejected' }
    $entry = $entries | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if (-not $entry) { Write-Failure "no finding with id: $Id" }

    $findingPath = Join-Path $findingsRoot "$Id.md"
    if (-not (Test-Path -LiteralPath $findingPath)) { Write-Failure "finding file is missing: $findingPath" }
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $body = Get-Content -LiteralPath $findingPath -Raw -Encoding UTF8
    # \r?$ on every anchor: these files are written CRLF, and .NET's $ in multiline mode matches
    # only before a bare \n, so a plain anchor makes the replace a silent no-op.
    $body = [regex]::Replace($body, '(?m)^status:[ \t]*\S+[ \t]*(\r?)$', "status: $Status`${1}")
    $body = [regex]::Replace($body, '(?m)^resolved_at:[ \t]*.*?(\r?)$', "resolved_at: $stamp`${1}")
    $escapedNote = ($Note -replace '"', '\"')
    $body = [regex]::Replace($body, '(?m)^resolution_note:[ \t]*.*?(\r?)$', "resolution_note: `"$escapedNote`"`${1}")
    [IO.File]::WriteAllText($findingPath, $body, $utf8NoBom)

    $entry.status = $Status
    Save-Index $index $entries
    Write-Result ([pscustomobject]@{ ok = $true; id = $Id; status = $Status })
    exit 0
}

# --- Record ---------------------------------------------------------------------------------

if (-not $ProposedChange) {
    Write-Failure 'Record needs -ProposedChange naming the file and rule to change; "be more careful" is not a finding'
}

if (-not $TaskPath) {
    $resolverPath = Join-Path $PSScriptRoot 'project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolverPath)) { Write-Failure "project-resolver.ps1 not found: $resolverPath" }
    $resolved = (& $resolverPath -Path $Path -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -ne 1) { Write-Failure 'no single in_progress task in this worktree; pass -TaskPath' }
    $TaskPath = $active[0]
}
if (-not (Test-Path -LiteralPath $TaskPath)) { Write-Failure "task file not found: $TaskPath" }

$rawTask = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
$taskContent = [regex]::Replace($rawTask, '(?s)<!--.*?-->', '')
$section = [regex]::Match($taskContent, '(?ms)^## Retrospective result.*?\r?\n(.*?)(?=^## |\z)').Groups[1].Value.Trim()
if (-not $section) { Write-Failure "task has no '## Retrospective result' section: $TaskPath" }

$classification = Get-Field $section 'classification'
if ($gapRequired -notcontains $classification) {
    Write-Failure "only a regression is recorded as a framework gap; this task is classified '$classification'"
}
$missCategory = Get-Field $section 'miss_category'
if (-not $missCategory -or $missCategories -notcontains $missCategory) {
    Write-Failure "miss_category must be one of: $($missCategories -join ', ') (task has '$missCategory')"
}

$taskId = [regex]::Match($taskContent, '(?m)^id:[ \t]*(\S+)[ \t]*\r?$').Groups[1].Value
if (-not $taskId) { Write-Failure "task has no id in frontmatter: $TaskPath" }
$projectId = [regex]::Match($taskContent, '(?m)^project_id:[ \t]*(\S+)[ \t]*\r?$').Groups[1].Value
$worktreeId = [regex]::Match($taskContent, '(?m)^worktree_id:[ \t]*(\S+)[ \t]*\r?$').Groups[1].Value

# The whole reason this store exists is triaging findings from OTHER repositories, so `repo` has
# to be where the code actually lives - never derived from $TaskPath, which sits under the state
# root (~/.agent-workflow/projects/<id>/tasks/<task-id>/task.md) and has no relationship to it.
# project.json is the only place that mapping is recorded: the matching worktree's path, or the
# project's canonical_root if the worktree was not (or no longer) registered.
$repo = ''
if ($projectId) {
    $projectJsonPath = Join-Path $StateRoot "projects\$projectId\project.json"
    if (Test-Path -LiteralPath $projectJsonPath) {
        try {
            $project = Get-Content -LiteralPath $projectJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $worktree = @($project.worktrees) | Where-Object { $_.id -eq $worktreeId } | Select-Object -First 1
            $repo = if ($worktree) { $worktree.path } else { $project.canonical_root }
        } catch {
            # A finding is still worth recording without a resolvable repo path; the reader can
            # follow up from task_id and project_id instead of losing the finding entirely.
            $repo = ''
        }
    }
}

$title = [regex]::Match($taskContent, '(?m)^#[ \t]+(.+?)[ \t]*\r?$').Groups[1].Value.Trim()
if (-not $title) { $title = $taskId }
$introducedBy = Get-Field $section 'introduced_by'
$gapEvidence = Get-Field $section 'gap_evidence'

# One finding per (task, category). A close that is retried, or a task that records twice, must
# not inflate the count - the threshold is the entire escalation mechanism.
$existing = $entries | Where-Object { $_.task_id -eq $taskId -and $_.miss_category -eq $missCategory } | Select-Object -First 1

$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
if ($existing) {
    $findingId = $existing.id
} else {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$taskId|$missCategory"))
    } finally {
        $sha.Dispose()
    }
    $short = -join (($digest[0..3]) | ForEach-Object { $_.ToString('x2') })
    $findingId = (Get-Date).ToString('yyyyMMdd-HHmmss') + "-$short"
}

New-Item -ItemType Directory -Force -Path $findingsRoot | Out-Null
$findingBody = @"
---
id: $findingId
created_at: $stamp
project_id: "$projectId"
task_id: $taskId
repo: "$repo"
classification: $classification
miss_category: $missCategory
introduced_by: "$($introducedBy -replace '"', '\"')"
status: open
resolved_at:
resolution_note:
---

# $title

## Gap evidence

$gapEvidence

## Proposed framework change

$ProposedChange
"@
[IO.File]::WriteAllText((Join-Path $findingsRoot "$findingId.md"), ($findingBody -replace "`r?`n", "`r`n"), $utf8NoBom)

if (-not $existing) {
    $entries += [pscustomobject]@{
        id = $findingId
        task_id = $taskId
        project_id = $projectId
        miss_category = $missCategory
        classification = $classification
        status = 'open'
        created_at = $stamp
    }
}
Save-Index $index $entries

# Only open findings count. A gap that was applied is fixed and a gap that was rejected was a
# decision; if either recurs it starts earning its way back to the threshold from scratch.
$occurrences = @($entries | Where-Object { $_.miss_category -eq $missCategory -and $_.status -eq 'open' }).Count
Write-Result ([pscustomobject]@{
    ok = $true
    id = $findingId
    task_id = $taskId
    miss_category = $missCategory
    occurrences = $occurrences
    escalate = ($occurrences -ge $threshold)
    path = (Join-Path $findingsRoot "$findingId.md")
})
exit 0
