[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Init', 'Collect', 'Apply', 'Resolve', 'Reject', 'Cleanup', 'Status')][string]$Action,
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [string]$PlanPath,
    [string]$WorkerId
)

# Manual coordinator/worker orchestration. This script never starts an agent: workers are
# launched by hand with their own worktree as cwd. It is the only supported writer of the
# main working tree, and it only ever writes via `git apply` (no index, no commit, no refs).

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$scriptRoot = $PSScriptRoot
$resolverPath = Join-Path $scriptRoot 'project-resolver.ps1'
$checkTaskPath = Join-Path $scriptRoot 'check-task.ps1'

function Fail([string]$Message) { Write-Error $Message; exit 1 }

function Invoke-Git([string]$Repo, [string[]]$GitArgs, [hashtable]$Env = @{}) {
    $old = @{}
    foreach ($key in $Env.Keys) { $old[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $Env[$key]) }
    # git writes routine progress (e.g. "Preparing worktree") to stderr even on success. With
    # $ErrorActionPreference = 'Stop', capturing that via 2>&1 promotes it to a terminating
    # error; relax the preference for just this call so a clean exit is not mistaken for one.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $Repo @GitArgs 2>&1
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String) }
    } finally {
        $ErrorActionPreference = $previous
        foreach ($key in $Env.Keys) { [Environment]::SetEnvironmentVariable($key, $old[$key]) }
    }
}

# Capturing native stdout through PowerShell's line-object pipeline (`& git ... | Out-String`)
# splits on newlines and rejoins with `[Environment]::NewLine`, silently turning every LF in a
# diff into CRLF and corrupting the patch. `--name-status -z` output is NUL-delimited with no
# newlines, so it is less exposed but still not guaranteed safe through that path. Both the
# patch body and the name-status listing are read as raw bytes via Process directly instead.
function Format-CommandArg([string]$Arg) {
    if ($Arg -eq '') { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * ($backslashes * 2 + 1)); [void]$sb.Append('"'); $backslashes = 0; continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Invoke-GitRawBytes([string]$Repo, [string[]]$GitArgs, [hashtable]$Env = @{}) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'git'
    $psi.Arguments = ((@('-C', $Repo) + $GitArgs) | ForEach-Object { Format-CommandArg $_ }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($key in $Env.Keys) { $psi.EnvironmentVariables[$key] = $Env[$key] }
    $proc = [Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.BaseStream
    $buffer = New-Object IO.MemoryStream
    $stdoutTask.CopyTo($buffer)
    $stderrText = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Bytes = $buffer.ToArray(); StdErr = $stderrText }
}

function Get-Sha256([string]$FilePath) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($FilePath)
        try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

# Phase 1 supports the ordinary case only. Each of these changes what a diff against a commit
# actually means, so producing a patch under them would fail silently rather than loudly.
function Assert-StandardRepository([string]$Repo) {
    if ((Invoke-Git $Repo @('rev-parse', '--is-bare-repository')).Output.Trim() -eq 'true') { Fail 'parallel orchestration does not support bare repositories.' }
    if (Test-Path -LiteralPath (Join-Path $Repo '.gitmodules')) { Fail 'parallel orchestration does not support submodules.' }
    if ((Invoke-Git $Repo @('config', '--bool', 'core.sparseCheckout')).Output.Trim() -eq 'true') { Fail 'parallel orchestration does not support sparse checkout.' }
    if (Test-Path -LiteralPath (Join-Path $Repo '.lfsconfig')) { Fail 'parallel orchestration does not support Git LFS.' }
    # `git stash create` fails (nonzero exit, empty stdout) when a merge/rebase/cherry-pick is in
    # progress or the index has unmerged entries. Catching that here, before Get-Baseline runs,
    # keeps the failure obvious instead of surfacing as a baffling error from `git worktree add`
    # several steps later.
    $gitDir = (Invoke-Git $Repo @('rev-parse', '--git-dir')).Output.Trim()
    if ($gitDir) {
        $gitDirFull = if ([IO.Path]::IsPathRooted($gitDir)) { $gitDir } else { Join-Path $Repo $gitDir }
        foreach ($marker in @('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD')) {
            if (Test-Path -LiteralPath (Join-Path $gitDirFull $marker)) { Fail "the repository has an unfinished $marker; resolve or abort it before splitting work." }
        }
    }
}

# `git stash create` writes a commit object recording the current tracked modifications without
# touching HEAD, refs, the index or the working tree. Using it as the worktree base means every
# worker starts from what the user actually has on disk, so there is no stale-baseline class of
# bug to audit. It captures TRACKED changes only - Init checks untracked files separately.
#
# The three fingerprints pin the main working tree as it was at Init: Apply refuses to touch a
# tree that moved underneath the split. Hashing raw bytes, not PowerShell strings, for the same
# newline-fidelity reason documented on Invoke-GitRawBytes.
function Get-Baseline([string]$Repo) {
    $head = (Invoke-Git $Repo @('rev-parse', 'HEAD')).Output.Trim()
    $stashResult = Invoke-Git $Repo @('stash', 'create')
    if ($stashResult.ExitCode -ne 0) { Fail "git stash create failed: $($stashResult.Output.Trim())" }
    $stash = $stashResult.Output.Trim()
    # Invoke-Git folds stderr into Output; a clean run either prints nothing (clean tree) or a
    # single commit sha. Anything else means the "sha" is actually stray Git chatter that would
    # otherwise become `base` and fail confusingly at `git worktree add` instead of here.
    if ($stash -and $stash -notmatch '^[0-9a-f]{40}$') { Fail "git stash create returned unexpected output instead of a commit sha: $stash" }
    $working = Invoke-GitRawBytes $Repo @('diff', '--binary', '--full-index', '--no-renames', 'HEAD')
    $index = Invoke-GitRawBytes $Repo @('diff', '--cached', '--binary', '--full-index', '--no-renames', 'HEAD')
    return [pscustomobject]@{
        base = if ($stash) { $stash } else { $head }
        head = $head
        worktree_fingerprint = Get-BytesSha256 $working.Bytes
        index_fingerprint = Get-BytesSha256 $index.Bytes
    }
}

function Read-Json([string]$FilePath) { return Get-Content -LiteralPath $FilePath -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json([string]$FilePath, $Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $FilePath) | Out-Null
    [IO.File]::WriteAllText($FilePath, ($Value | ConvertTo-Json -Depth 8), $utf8NoBom)
}

function Set-Frontmatter([string]$TaskFile, [hashtable]$Fields) {
    # .NET's `$` in multiline mode matches only right before a bare \n; on a CRLF-terminated
    # line, [^\r\n]* stops at \r and $ does not match there. Every line-ending anchor in this
    # function must consume an optional \r before $, matching the convention already used in
    # quality-gate.ps1 (e.g. its `\r?$` PASS-line patterns).
    $text = Get-Content -LiteralPath $TaskFile -Raw -Encoding UTF8
    $eol = if ($text -match "`r`n") { "`r`n" } else { "`n" }
    foreach ($key in $Fields.Keys) {
        $pattern = "(?m)^$([regex]::Escape($key)):[ \t]*[^\r\n]*\r?$"
        $replacement = "$($key): $($Fields[$key])"
        if ($text -match $pattern) { $text = [regex]::Replace($text, $pattern, $replacement) }
        else { $text = [regex]::Replace($text, '(?m)^(updated_at:[^\r\n]*)\r?$', "`$1$eol$replacement", 1) }
    }
    [IO.File]::WriteAllText($TaskFile, $text, $utf8NoBom)
}

function Get-Field([string]$Content, [string]$Name) {
    if ($Content -match "(?m)^$([regex]::Escape($Name)):[ \t]*([^\r\n]*)") { return $Matches[1].Trim() }
    return ''
}

# --- ownership -------------------------------------------------------------

function Test-OwnershipEntry([string]$Entry) {
    if (-not $Entry) { return 'must not be empty' }
    if ($Entry -match '^([a-zA-Z]:|/|\\)') { return 'must be repo-relative' }
    if ($Entry -match '\\') { return 'must use / as the separator' }
    if ($Entry -like './*') { return 'must not start with ./' }
    if ($Entry -match '(^|/)\.\.(/|$)') { return 'must not contain ..' }
    if ($Entry -match '[\[\],]') { return 'must not contain , [ or ]' }
    return ''
}

# Windows paths are case-insensitive, so ownership comparison must be too: comparing
# ordinally would let src/Payment/ and src/payment/ claim the same directory.
function Test-PathOwned([string]$RepoPath, [string[]]$Prefixes) {
    foreach ($prefix in $Prefixes) {
        if ($prefix.EndsWith('/')) {
            if ($RepoPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        } elseif ($RepoPath.Equals($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-PrefixOverlap([string]$Left, [string]$Right) {
    if ($Left.Equals($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Left.EndsWith('/') -and $Right.StartsWith($Left, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Right.EndsWith('/') -and $Left.StartsWith($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

# `--name-status -z` normally emits R/C entries as status\0old\0new and everything else as
# status\0path, which desynchronises a fixed-stride reader from the first rename onward. Every
# diff here is taken with --no-renames, so renames are already decomposed into a delete plus an
# add and only the two-field form can occur. The R/C guard is not decoration: if a future change
# drops --no-renames, this must stop rather than silently misread every path after the first.
function Read-NameStatusZ([byte[]]$Bytes) {
    $fields = @([Text.Encoding]::UTF8.GetString($Bytes) -split "`0" | Where-Object { $_ -ne '' })
    $result = @()
    for ($i = 0; $i + 1 -lt $fields.Count; $i += 2) {
        if ($fields[$i] -match '^[RC]') { throw "rename/copy status '$($fields[$i])' appeared in a --no-renames diff" }
        $result += [pscustomobject]@{ status = $fields[$i]; path = $fields[$i + 1] }
    }
    return $result
}

# --- context ---------------------------------------------------------------

$resolved = (& $resolverPath -Path $Path -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
if (-not $resolved.is_git) { Fail 'orchestrate must run inside a git repository.' }

$coordinatorTask = ''
$coordinatorId = ''
$active = @($resolved.active_tasks)
if ($active.Count -eq 1) {
    $candidate = Get-Content -LiteralPath $active[0] -Raw -Encoding UTF8
    if ((Get-Field $candidate 'subtask_role') -eq 'coordinator') {
        $coordinatorTask = $active[0]
        $coordinatorId = Get-Field $candidate 'id'
    }
}

# Caller validation. This stops a worker from misusing a mutating action from its own cwd or
# from a terminal task; it is NOT an identity check - see orchestration.md known limitations.
if ($Action -ne 'Status' -and -not $coordinatorTask) {
    Fail "orchestrate -Action $Action requires exactly one active coordinator task in the current worktree ($($resolved.root))."
}

$projectDir = $resolved.project_dir
$taskRoot = $resolved.task_root
$worktreeRoot = Join-Path $projectDir 'worktrees'

function Get-Roster {
    if (-not $coordinatorId) { return @() }
    $r = (& $resolverPath -Path $Path -StateRoot $StateRoot -RosterFor $coordinatorId | Out-String) | ConvertFrom-Json
    return @($r.roster)
}

# Named $TaskId rather than $WorkerId so these never read as the script-level -WorkerId switch
# that only -Action Resolve consumes.
function Get-WorkerTaskFile([string]$TaskId) { return Join-Path $taskRoot "$TaskId\task.md" }
function Get-WorkerWorktree([string]$TaskId) { return Join-Path $worktreeRoot $TaskId }
function Get-DeliveryFile([string]$TaskId) { return Join-Path $taskRoot "$TaskId\delivery.json" }
function Get-PatchFile([string]$TaskId) { return Join-Path $taskRoot "$TaskId\delivery.patch" }

# Provenance only. Every status lives in task frontmatter - this file exists because the three
# baseline fingerprints and the open conflict list are too long to belong there, and nothing
# else may be added to it: two sources of truth for status is exactly what this design avoids.
function Get-OrchestrationFile { return Join-Path $taskRoot "$coordinatorId\orchestration.json" }
function Get-Orchestration {
    $file = Get-OrchestrationFile
    if (-not (Test-Path -LiteralPath $file)) { Fail "no orchestration record for $coordinatorId; run -Action Init first." }
    return Read-Json $file
}

function Get-CoordinatorField([string]$Name) {
    return Get-Field (Get-Content -LiteralPath $coordinatorTask -Raw -Encoding UTF8) $Name
}

# Shared by Resolve and Reject: both remove one entry from the outstanding set and need to know
# whether that was the last one. Re-derived from the roster and the (already-updated) conflict
# list each time rather than tracked incrementally, so it can never drift from what is actually
# on disk.
function Complete-IntegrationIfDone($Orchestration) {
    $unresolved = @(Get-Roster | Where-Object { @('applied','merged','rejected','skipped') -notcontains $_.delivery_status })
    if (@($Orchestration.conflicts).Count -eq 0 -and $unresolved.Count -eq 0) {
        Set-Frontmatter $coordinatorTask @{ integration_status = 'applied'; updated_at = (Get-Date).ToString('o') }
        return 'all deliveries resolved; integration_status = applied'
    }
    $remaining = @($Orchestration.conflicts | ForEach-Object { $_.worker }) + @($unresolved | ForEach-Object { $_.id })
    return ('still outstanding: ' + (@($remaining | Select-Object -Unique) -join ', '))
}

# Produces the patch for a worktree through a throwaway index so the worker's own index,
# refs and commits are never touched.
function New-DeliveryPatch([string]$WorkerWorktree, [string]$Baseline, [string]$PatchFile) {
    $tempIndex = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-index-' + [guid]::NewGuid().ToString('N'))
    $env = @{ GIT_INDEX_FILE = $tempIndex }
    try {
        $readTree = Invoke-Git $WorkerWorktree @('read-tree', $Baseline) $env
        if ($readTree.ExitCode -ne 0) { throw "read-tree failed: $($readTree.Output)" }
        $add = Invoke-Git $WorkerWorktree @('add', '-A') $env
        if ($add.ExitCode -ne 0) { throw "add -A failed: $($add.Output)" }

        # --no-renames keeps every entry single-path (see Read-NameStatusZ) and makes a rename
        # apply as a delete plus an add, which is also what makes path-level conflict detection
        # and hand merging tractable. --full-index keeps the patch applicable after a gc.
        $diff = Invoke-GitRawBytes $WorkerWorktree @('diff', '--cached', '--binary', '--full-index', '--no-renames', $Baseline) $env
        if ($diff.ExitCode -ne 0) { throw "diff failed: $($diff.StdErr)" }
        $names = Invoke-GitRawBytes $WorkerWorktree @('diff', '--cached', '--name-status', '--no-renames', '-z', $Baseline) $env
        if ($names.ExitCode -ne 0) { throw "diff --name-status failed: $($names.StdErr)" }

        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PatchFile) | Out-Null
        [IO.File]::WriteAllBytes($PatchFile, $diff.Bytes)
        return Read-NameStatusZ $names.Bytes
    } finally {
        Remove-Item -LiteralPath $tempIndex -Force -ErrorAction SilentlyContinue
    }
}

# --- actions ---------------------------------------------------------------

switch ($Action) {

'Init' {
    if (-not $PlanPath) { Fail 'Init requires -PlanPath pointing at a split plan JSON file.' }
    if (Test-Path -LiteralPath (Get-OrchestrationFile)) { Fail "coordinator $coordinatorId already has an orchestration record; use -Action Status." }

    # Eligibility first: split-plan.ps1 owns every rule about whether this work may be split at
    # all (freeze, user confirmation, ordering, shared state, ownership grammar and disjointness,
    # default-serial surfaces). Nothing is created unless it says yes.
    $eligibility = (& (Join-Path $scriptRoot 'split-plan.ps1') -CoordinatorTaskPath $coordinatorTask -PlanPath $PlanPath | Out-String) | ConvertFrom-Json
    if (-not $eligibility.eligible) {
        Fail ("the split plan is not eligible; nothing was created:`n  " + (@($eligibility.errors) -join "`n  "))
    }

    $headProbe = Invoke-Git $resolved.root @('rev-parse', '--verify', 'HEAD')
    if ($headProbe.ExitCode -ne 0) { Fail 'the repository has no HEAD; commit something before splitting work.' }
    Assert-StandardRepository $resolved.root

    $specs = @()
    foreach ($workerPlan in @($eligibility.workers)) {
        $specs += [pscustomobject]@{ slug = [string]$workerPlan.id; prefixes = @($workerPlan.file_ownership | ForEach-Object { [string]$_ }) }
    }

    $baselineInfo = Get-Baseline $resolved.root
    $baseline = $baselineInfo.base

    # `git stash create` records tracked modifications only. An untracked file inside a worker's
    # ownership is therefore invisible in its worktree, the worker recreates it from scratch, and
    # `git apply` then fails on the already-present file back here. Cheaper to refuse up front.
    $untracked = @((Invoke-Git $resolved.root @('ls-files', '--others', '--exclude-standard')).Output -split '\r?\n' | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ })
    $collisions = @()
    foreach ($spec in $specs) {
        $hits = @($untracked | Where-Object { Test-PathOwned $_ $spec.prefixes })
        if ($hits.Count -gt 0) { $collisions += "$($spec.slug): $($hits -join ', ')" }
    }
    if ($collisions.Count -gt 0) {
        Fail ("untracked files fall inside declared ownership; workers cannot see them (git stash create captures tracked changes only) and applying their deliveries would collide:`n  " + ($collisions -join "`n  ") + "`ncommit or remove those files, narrow the ownership, or keep this as a single sequential task.")
    }

    $created = @()
    $index = 0
    foreach ($spec in $specs) {
        $index++
        $workerId = '{0}-{1}' -f ((Get-Date).AddSeconds($index).ToString('yyyyMMdd-HHmmss')), $spec.slug
        $workerWorktree = Join-Path $worktreeRoot $workerId
        $add = Invoke-Git $resolved.root @('worktree', 'add', '--detach', $workerWorktree, $baseline)
        if ($add.ExitCode -ne 0) { Fail "git worktree add failed for '$($spec.slug)': $($add.Output)" }
        $created += [pscustomobject]@{ id = $workerId; slug = $spec.slug; worktree = $workerWorktree; prefixes = $spec.prefixes }
    }

    & $resolverPath -Path $Path -StateRoot $StateRoot -RegisterWorktree @($created | ForEach-Object { $_.worktree }) | Out-Null

    $bootstrap = Join-Path $resolved.root '.agent-workflow-worktree-init.ps1'
    foreach ($entry in $created) {
        if (Test-Path -LiteralPath $bootstrap -PathType Leaf) {
            $hostExe = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell.exe' }
            & $hostExe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -WorktreePath $entry.worktree | Out-Null
            $after = @((Invoke-Git $entry.worktree @('status', '--porcelain')).Output -split '\r?\n' | Where-Object { $_ })
            if ($after.Count -gt 0) {
                Fail "the worktree bootstrap left '$($entry.id)' dirty; those files would be swept into every delivery patch:`n  " + ($after -join "`n  ")
            }
        }

        $workerWorktreeId = ((& $resolverPath -Path $entry.worktree -StateRoot $StateRoot | Out-String) | ConvertFrom-Json).worktree_id
        $now = (Get-Date).ToString('o')
        $body = @"
---
id: $($entry.id)
project_id: $($resolved.project_id)
worktree_id: $workerWorktreeId
status: in_progress
code_change: true
risk_flags: []
created_at: $now
updated_at: $now
subtask_role: worker
parent_task_id: $coordinatorId
base_commit: $baseline
file_ownership: [$($entry.prefixes -join ', ')]
delivery_status: pending
---

# worker: $($entry.slug)

## Goal

<what this worker must deliver>

## Scope

<files and behaviour in scope; everything else is out of scope>

## Completion criteria

- [ ] expected behaviour delivered
- [ ] related verification passed

## Validation results

- pre-review: <PASS | FAIL | SKIP>
- command: <actual command>
- checks: <what ran and the result>
- skip reason: <only when SKIP>
- limitations: <unverified limits; none if there are none>
- diff_sha256: <required when pre-review PASSes; output of worktree-fingerprint.ps1 -Path <worktree> -Base $baseline>

## Parent task

- coordinator: $coordinatorId
- base commit: $baseline
- worktree: $($entry.worktree)
- Reviewer diff base: git diff $baseline

## File ownership

$(($entry.prefixes | ForEach-Object { "- $_" }) -join "`r`n")

## Project docs

- read: <project-doc.ps1 -Action Lookup path(s) read before editing code, or 'none - <reason>'; impact-guard blocks all code edits until this is filled>
- updated: <doc path(s) touched, or 'none - <reason>'>

## Impact surface

<callers / entrypoints / shared state / unverified nodes - fill before editing code>

## Execution path and regression evidence

<entry > change > endpoints>

## Reviewer result

## Verifier result
"@
        $taskFile = Get-WorkerTaskFile $entry.id
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskFile) | Out-Null
        # PowerShell double-quoted strings treat `` `r `` / `` `n `` as literal control chars, not
        # regex escapes, so the pattern here must be single-quoted to form the real regex \r?\n.
        [IO.File]::WriteAllText($taskFile, ($body -replace '\r?\n', "`r`n"), $utf8NoBom)
    }

    Write-Json (Get-OrchestrationFile) ([ordered]@{
        coordinator_task_id = $coordinatorId
        base_commit = $baseline
        head = $baselineInfo.head
        worktree_fingerprint = $baselineInfo.worktree_fingerprint
        index_fingerprint = $baselineInfo.index_fingerprint
        created_at = (Get-Date).ToString('o')
        baseline_verified_at = ''
        conflicts = @()
    })
    Set-Frontmatter $coordinatorTask @{ integration_status = 'pending'; updated_at = (Get-Date).ToString('o') }

    Write-Output "initialised $($created.Count) worker(s) from base $baseline"
    if ($baseline -ne $baselineInfo.head) { Write-Output "  (base includes the uncommitted changes in $($resolved.root); HEAD is $($baselineInfo.head))" }
    foreach ($entry in $created) {
        Write-Output ''
        Write-Output "worker $($entry.slug)"
        Write-Output "  worktree              : $($entry.worktree)"
        Write-Output "  task                  : $(Get-WorkerTaskFile $entry.id)"
        Write-Output "  task id               : $($entry.id)"
        Write-Output "  coordinator task id   : $coordinatorId"
        Write-Output "  file_ownership        : $($entry.prefixes -join ', ')"
        Write-Output "  start with cwd        : $($entry.worktree)"
        Write-Output "  worker role           : ~/.agents/agents/worker.md"
        Write-Output "  workflow skill        : ~/.agents/skills/workflow/SKILL.md"
        Write-Output "  orchestration context : ~/.agents/skills/workflow/orchestration.md"
    }
}

'Collect' {
    $orchestration = Get-Orchestration
    $roster = Get-Roster
    if ($roster.Count -eq 0) { Fail 'no worker tasks are registered under this coordinator.' }

    # blocked is not terminal for collection purposes: a blocked worker is fixed forward in its
    # own worktree, so waiting for it is the only correct behaviour.
    $notTerminal = @($roster | Where-Object { @('done','superseded') -notcontains $_.status })
    if ($notTerminal.Count -gt 0) {
        Fail ("cannot collect while worker(s) are still running or blocked: " + (@($notTerminal | ForEach-Object { "$($_.id) [$($_.status)]" }) -join ', '))
    }

    $collected = 0
    foreach ($entry in $roster) {
        if ($entry.status -ne 'done') {
            # superseded only ever means "the user cancelled this worker's scope"; there is no
            # retry-attempt lineage in this design, workers are fixed forward in place.
            Set-Frontmatter (Get-WorkerTaskFile $entry.id) @{ delivery_status = 'skipped'; updated_at = (Get-Date).ToString('o') }
            Write-Output "$($entry.id): $($entry.status) -> delivery skipped"
            continue
        }
        if ($entry.delivery_status -ne 'pending') { Write-Output "$($entry.id): already $($entry.delivery_status), left alone"; continue }

        $check = (& $checkTaskPath -TaskPath (Get-WorkerTaskFile $entry.id) -Mode Worker -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
        if (-not $check.valid) {
            Fail ("worker $($entry.id) is marked done but its task is incomplete; nothing was collected: " + (@($check.issues) -join ' | '))
        }

        $workerWorktree = Get-WorkerWorktree $entry.id
        if (-not (Test-Path -LiteralPath $workerWorktree -PathType Container)) { Fail "worker worktree is missing: $workerWorktree" }

        $taskText = Get-Content -LiteralPath (Get-WorkerTaskFile $entry.id) -Raw -Encoding UTF8
        # base_commit is frontmatter, not prose in the Parent task section: validate-task.ps1
        # enforces its shape, and a hand-edited narrative line cannot silently redirect the diff.
        $baseline = Get-Field $taskText 'base_commit'
        if (-not $baseline) { Fail "worker $($entry.id) does not record a base_commit" }
        if ($baseline -ne $orchestration.base_commit) { Fail "worker $($entry.id) records base_commit $baseline but this split was created from $($orchestration.base_commit)" }
        $currentHead = (Invoke-Git $workerWorktree @('rev-parse', 'HEAD')).Output.Trim()
        if ($currentHead -ne $baseline) { Fail "worker $($entry.id) moved off its base commit ($baseline -> $currentHead); refusing to collect" }

        $patchFile = Get-PatchFile $entry.id
        # @(...): New-DeliveryPatch returns Read-NameStatusZ's array, but PowerShell unwraps a
        # single-element array to a scalar across a function return. Left unguarded, a one-file
        # delivery makes $changed a bare pscustomobject - `.Count` on it is $null, not 1, and the
        # "collected N path(s)" message below prints a blank instead of a number.
        $changed = @(New-DeliveryPatch $workerWorktree $baseline $patchFile)
        if ((Get-Item -LiteralPath $patchFile).Length -eq 0) {
            Remove-Item -LiteralPath $patchFile -Force
            # Coordinator status is deliberately left untouched: flipping it to blocked here would
            # take active_tasks out of the resolver's view and lock the coordinator out of the very
            # actions (re-dispatch, reduce scope) this message tells it to take. status changes are
            # the coordinator's own deliberate action, never an automatic side effect of a Fail.
            Fail "worker $($entry.id) is marked done but its patch is empty; decide whether to re-dispatch, reduce scope, or fall back to a sequential task."
        }

        $ownership = @()
        if ($taskText -match '(?m)^file_ownership:[ \t]*\[(.*)\]') {
            $ownership = @($Matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        # impact-guard already denies out-of-lane edits made through a platform edit tool; this
        # is the second layer, covering whatever a shell script wrote where no hook could see it.
        $outOfScope = @()
        foreach ($change in $changed) {
            if (-not (Test-PathOwned $change.path $ownership) -and $outOfScope -notcontains $change.path) { $outOfScope += $change.path }
        }

        Write-Json (Get-DeliveryFile $entry.id) ([ordered]@{
            worker_task_id = $entry.id
            base_commit = $baseline
            patch_sha256 = (Get-Sha256 $patchFile)
            changed_paths = @($changed)
            ownership_findings = [ordered]@{ out_of_scope = @($outOfScope); overlap_with = @() }
            apply_error = ''
            collected_at = (Get-Date).ToString('o')
            applied_at = ''
        })
        $collected++
        $suffix = if ($outOfScope.Count -gt 0) { " (out_of_scope: $($outOfScope -join ', '))" } else { '' }
        Write-Output "$($entry.id): collected $($changed.Count) path(s)$suffix"
    }
    Write-Output "collected $collected delivery/deliveries"
}

'Apply' {
    $orchestration = Get-Orchestration
    $roster = Get-Roster
    if ($roster.Count -eq 0) { Fail 'no worker tasks are registered under this coordinator.' }

    $notTerminal = @($roster | Where-Object { @('done','superseded') -notcontains $_.status })
    if ($notTerminal.Count -gt 0) {
        Fail ('worker(s) are not finished: ' + (@($notTerminal | ForEach-Object { "$($_.id) [$($_.status)]" }) -join ', ') + '. A blocked worker is fixed forward in its own worktree, or its scope is cancelled by the user (superseded).')
    }

    $candidates = @()
    foreach ($entry in @($roster | Where-Object { $_.status -eq 'done' })) {
        $deliveryFile = Get-DeliveryFile $entry.id
        if (-not (Test-Path -LiteralPath $deliveryFile)) { Fail "worker $($entry.id) has not been collected yet; run -Action Collect first." }
        $delivery = Read-Json $deliveryFile
        $patchFile = Get-PatchFile $entry.id
        if (-not (Test-Path -LiteralPath $patchFile)) { Fail "delivery patch is missing for $($entry.id)" }
        # Only a delivery still awaiting a decision needs its hash/out_of_scope checked. Checking
        # every 'done' worker unconditionally would re-Fail forever on a delivery the coordinator
        # already rejected or resolved - out_of_scope findings are historical fact recorded at
        # Collect time and never cleared, they do not mean "still unresolved".
        if ($entry.delivery_status -eq 'pending') {
            if ((Get-Sha256 $patchFile) -ne $delivery.patch_sha256) { Fail "delivery patch for $($entry.id) does not match the hash recorded at collection time" }
            if (@($delivery.ownership_findings.out_of_scope).Count -gt 0) {
                Fail ("worker $($entry.id) changed files outside its ownership and needs a user decision: widen the ownership and re-collect, or run -Action Reject -WorkerId $($entry.id) to discard it. out_of_scope = " + (@($delivery.ownership_findings.out_of_scope) -join ', '))
            }
        }
        $candidates += [pscustomobject]@{ id = $entry.id; delivery = $delivery; patch = $patchFile; status = $entry.delivery_status }
    }
    $candidates = @($candidates | Sort-Object -Property id)
    $pending = @($candidates | Where-Object { $_.status -eq 'pending' })
    if ($pending.Count -eq 0) { Fail 'every collected delivery is already resolved; nothing to apply.' }

    # The fingerprints pin the tree as it was at Init, so they can only be checked while nothing
    # has been applied yet. Once a conflict has been hand-merged the tree has legitimately moved
    # and each remaining delivery is gated by its own `git apply --check` instead. This is a
    # deliberate trade, recorded in orchestration.md, not an oversight.
    if ((Get-CoordinatorField 'integration_status') -eq 'pending') {
        $current = Get-Baseline $resolved.root
        if ($current.head -ne $orchestration.head -or
            $current.worktree_fingerprint -ne $orchestration.worktree_fingerprint -or
            $current.index_fingerprint -ne $orchestration.index_fingerprint) {
            Fail "the main working tree has changed since Init (HEAD, working tree or index); nothing was applied. Every delivery was produced against $($orchestration.base_commit) - restore that state, or abandon the split and go sequential."
        }
        $orchestration.baseline_verified_at = (Get-Date).ToString('o')
    }

    # Overlap is a cross-worker property, decidable only once every delivery is on disk, so it is
    # computed here in one pass rather than per-worker during Collect. Deliveries already in the
    # tree (applied/merged) stay in the comparison so a late candidate that collides with one of
    # them is named against the right worker instead of surfacing as an opaque apply failure.
    #
    # --no-renames means a rename is already a delete plus an add, so comparing `path` alone
    # covers the rename-versus-edit collision that would otherwise need old-path bookkeeping.
    function Get-TouchedPaths([object]$Delivery) {
        return @($Delivery.changed_paths | ForEach-Object { $_.path } | Where-Object { $_ } | Select-Object -Unique)
    }
    $inPlay = @($candidates | Where-Object { @('pending','applied','merged') -contains $_.status })
    $overlaps = @{}
    for ($i = 0; $i -lt $inPlay.Count; $i++) {
        for ($j = $i + 1; $j -lt $inPlay.Count; $j++) {
            $left = Get-TouchedPaths $inPlay[$i].delivery
            $right = Get-TouchedPaths $inPlay[$j].delivery
            $shared = @($left | Where-Object { $r = $_; @($right | Where-Object { $_.Equals($r, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 })
            if ($shared.Count -gt 0) {
                foreach ($pair in @(@($inPlay[$i].id, $inPlay[$j].id), @($inPlay[$j].id, $inPlay[$i].id))) {
                    if (-not $overlaps.ContainsKey($pair[0])) { $overlaps[$pair[0]] = @() }
                    $overlaps[$pair[0]] += [pscustomobject]@{ worker = $pair[1]; paths = @($shared) }
                }
            }
        }
    }

    $applied = 0
    $conflicts = @()
    foreach ($candidate in $pending) {
        $taskFile = Get-WorkerTaskFile $candidate.id
        $delivery = $candidate.delivery
        $failure = ''
        $conflictPaths = @()

        # A worker task that no longer passes its own gate is not a merge conflict: it means the
        # task was edited after collection. Stop outright rather than half-integrating.
        $check = (& $checkTaskPath -TaskPath $taskFile -Mode Worker -StateRoot $StateRoot | Out-String) | ConvertFrom-Json
        if (-not $check.valid) {
            Fail ("worker $($candidate.id) no longer passes its own checks; nothing further was applied: " + (@($check.issues) -join ' | '))
        }

        if ($overlaps.ContainsKey($candidate.id)) {
            $delivery.ownership_findings.overlap_with = @($overlaps[$candidate.id])
            $conflictPaths = @($overlaps[$candidate.id] | ForEach-Object { $_.paths } | Select-Object -Unique)
            $failure = 'overlaps with ' + (@($overlaps[$candidate.id] | ForEach-Object { "$($_.worker) on $($_.paths -join ', ')" }) -join '; ')
        } else {
            # No --index and no --3way: the index must stay untouched, and a 3-way apply would
            # write conflict markers plus staged entries into the main working tree.
            $dry = Invoke-Git $resolved.root @('apply', '--check', $candidate.patch)
            if ($dry.ExitCode -ne 0) {
                $failure = 'git apply --check failed: ' + $dry.Output.Trim()
                $conflictPaths = Get-TouchedPaths $delivery
            } else {
                $real = Invoke-Git $resolved.root @('apply', $candidate.patch)
                if ($real.ExitCode -ne 0) {
                    $failure = 'git apply failed: ' + $real.Output.Trim()
                    $conflictPaths = Get-TouchedPaths $delivery
                }
            }
        }

        $now = (Get-Date).ToString('o')
        if ($failure) {
            # Not rejected: the delivery stays pending and its work is preserved. The coordinator
            # merges it by hand and calls -Action Resolve. rejected is now reserved for a delivery
            # the user has explicitly decided to discard.
            $delivery.apply_error = $failure
            Write-Json (Get-DeliveryFile $candidate.id) $delivery
            $conflicts += [pscustomobject]@{ worker = $candidate.id; reason = $failure; paths = @($conflictPaths); patch = $candidate.patch; detected_at = $now }
            Write-Output "$($candidate.id): conflict - $failure"
        } else {
            $delivery.applied_at = $now
            Write-Json (Get-DeliveryFile $candidate.id) $delivery
            Set-Frontmatter $taskFile @{ delivery_status = 'applied'; updated_at = $now }
            $applied++
            Write-Output "$($candidate.id): applied"
        }
    }

    $orchestration.conflicts = @($conflicts)
    Write-Json (Get-OrchestrationFile) $orchestration

    $now = (Get-Date).ToString('o')
    if ($conflicts.Count -gt 0) {
        Set-Frontmatter $coordinatorTask @{ integration_status = 'conflicted'; updated_at = $now }
        Write-Output ''
        Write-Output "applied $applied, $($conflicts.Count) conflict(s); integration_status = conflicted"
        foreach ($conflict in $conflicts) {
            Write-Output ''
            Write-Output "conflict: $($conflict.worker)"
            Write-Output "  reason : $($conflict.reason)"
            Write-Output "  paths  : $($conflict.paths -join ', ')"
            Write-Output "  patch  : $($conflict.patch)"
        }
        Write-Output ''
        Write-Output 'Merge these by hand in the main working tree (impact-guard allows edits to the listed paths while integration_status is conflicted),'
        Write-Output 'ask the user about anything you cannot decide, record the decision in the Delivery log, then run -Action Resolve -WorkerId <id> for each.'
    } else {
        Set-Frontmatter $coordinatorTask @{ integration_status = 'applied'; updated_at = $now }
        Write-Output "applied $applied delivery/deliveries; integration_status = applied"
    }
}

'Resolve' {
    if (-not $WorkerId) { Fail 'Resolve requires -WorkerId naming the delivery that was merged by hand.' }
    $orchestration = Get-Orchestration
    $conflict = @($orchestration.conflicts | Where-Object { $_.worker -eq $WorkerId }) | Select-Object -First 1
    if (-not $conflict) { Fail "worker $WorkerId is not in the open conflict list for $coordinatorId." }

    $delivery = Read-Json (Get-DeliveryFile $WorkerId)
    # Verification is deliberately shallow: whether the merge is semantically right is what the
    # integration Reviewer and Verifier decide. What is checked here is that the merge was
    # actually carried out. Existence alone is not enough for an add/modify: an untouched path
    # that already existed at base_commit (the common shape for a same-file overlap, where BOTH
    # sides edit an existing tracked file) would pass a bare Test-Path while holding none of
    # either worker's change. `git diff --quiet <base> -- <path>` additionally requires the
    # content to actually differ from base, which a no-op "merge" cannot satisfy.
    $missing = @()
    foreach ($change in @($delivery.changed_paths)) {
        $full = Join-Path $resolved.root ($change.path -replace '/', '\')
        $exists = Test-Path -LiteralPath $full
        if ($change.status -eq 'D') {
            if ($exists) { $missing += "$($change.path) (should have been deleted)" }
            continue
        }
        if (-not $exists) { $missing += "$($change.path) (missing)"; continue }
        $diff = Invoke-Git $resolved.root @('diff', '--quiet', $delivery.base_commit, '--', $change.path)
        if ($diff.ExitCode -eq 0) { $missing += "$($change.path) (present but identical to base_commit - the merge does not appear to have landed)" }
    }
    if ($missing.Count -gt 0) {
        Fail ("worker $WorkerId is still not merged into the main working tree:`n  " + ($missing -join "`n  "))
    }

    $now = (Get-Date).ToString('o')
    $delivery.applied_at = $now
    $delivery.apply_error = "resolved by hand: $($conflict.reason)"
    Write-Json (Get-DeliveryFile $WorkerId) $delivery
    Set-Frontmatter (Get-WorkerTaskFile $WorkerId) @{ delivery_status = 'merged'; updated_at = $now }

    $orchestration.conflicts = @($orchestration.conflicts | Where-Object { $_.worker -ne $WorkerId })
    Write-Json (Get-OrchestrationFile) $orchestration
    Write-Output "${WorkerId}: merged"
    Write-Output (Complete-IntegrationIfDone $orchestration)
}

'Reject' {
    # The other terminal outcome for a delivery the coordinator will not integrate: the user
    # decided to discard it, whether it was flagged out_of_scope during Apply's pre-check or
    # named in an open conflict. Unlike Resolve, nothing needs to exist in the main working tree
    # - discarding is unconditional once the coordinator has made the call.
    if (-not $WorkerId) { Fail 'Reject requires -WorkerId naming the delivery to discard.' }
    $orchestration = Get-Orchestration
    $entry = @(Get-Roster | Where-Object { $_.id -eq $WorkerId }) | Select-Object -First 1
    if (-not $entry) { Fail "worker $WorkerId is not registered under $coordinatorId." }
    if ($entry.delivery_status -ne 'pending') { Fail "worker $WorkerId delivery_status is '$($entry.delivery_status)', not pending; nothing to reject." }
    $deliveryFile = Get-DeliveryFile $WorkerId
    if (-not (Test-Path -LiteralPath $deliveryFile)) { Fail "worker $WorkerId has not been collected yet; run -Action Collect first." }

    $now = (Get-Date).ToString('o')
    $delivery = Read-Json $deliveryFile
    $delivery.apply_error = 'rejected by user decision'
    Write-Json $deliveryFile $delivery
    Set-Frontmatter (Get-WorkerTaskFile $WorkerId) @{ delivery_status = 'rejected'; updated_at = $now }

    $orchestration.conflicts = @($orchestration.conflicts | Where-Object { $_.worker -ne $WorkerId })
    Write-Json (Get-OrchestrationFile) $orchestration
    Write-Output "${WorkerId}: rejected"
    Write-Output (Complete-IntegrationIfDone $orchestration)
}

'Cleanup' {
    $removed = 0
    foreach ($entry in Get-Roster) {
        $workerWorktree = Get-WorkerWorktree $entry.id
        if (-not (Test-Path -LiteralPath $workerWorktree -PathType Container)) { continue }
        # merged deliveries are as safe to clean up as applied ones: the hand merge happened in
        # the main working tree, the worker's worktree still holds exactly what it delivered.
        if (@('applied','merged','skipped') -notcontains $entry.delivery_status) {
            Write-Output "$($entry.id): kept for diagnosis (delivery_status = $($entry.delivery_status))"
            continue
        }
        if (@('done','blocked','superseded') -notcontains $entry.status) {
            Write-Output "$($entry.id): kept, task is not terminal (status = $($entry.status))"
            continue
        }

        if (@('applied','merged') -contains $entry.delivery_status) {
            # git diff alone would miss files added after collection, so the patch is rebuilt
            # exactly as Collect built it and compared by hash before anything is destroyed.
            $delivery = Read-Json (Get-DeliveryFile $entry.id)
            $probe = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-verify-' + [guid]::NewGuid().ToString('N') + '.patch')
            try {
                New-DeliveryPatch $workerWorktree $delivery.base_commit $probe | Out-Null
                if ((Get-Sha256 $probe) -ne $delivery.patch_sha256) {
                    Write-Output "$($entry.id): kept, the worktree no longer matches the delivered patch (edited after collection?)"
                    continue
                }
            } finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
        } else {
            $residual = @((Invoke-Git $workerWorktree @('status', '--porcelain')).Output -split '\r?\n' | Where-Object { $_ })
            if ($residual.Count -gt 0) { Write-Output "$($entry.id): kept, skipped worktree still holds uncommitted work"; continue }
        }

        # Scoped to this project's worktree root on purpose: never touch worktrees the user
        # or another tool created, and never run a bare `git worktree prune`.
        $remove = Invoke-Git $resolved.root @('worktree', 'remove', '--force', $workerWorktree)
        if ($remove.ExitCode -ne 0) { Write-Output "$($entry.id): removal failed - $($remove.Output.Trim())"; continue }
        $removed++
        Write-Output "$($entry.id): worktree removed"
    }
    Write-Output "removed $removed worktree(s)"
}

'Status' {
    $roster = Get-Roster
    Write-Output "coordinator : $(if ($coordinatorId) { $coordinatorId } else { '(none in this worktree)' })"
    Write-Output "repo root   : $($resolved.root)"
    $orchestration = $null
    if ($coordinatorTask) {
        Write-Output "integration : $(Get-CoordinatorField 'integration_status')"
        $orchestrationFile = Get-OrchestrationFile
        if (Test-Path -LiteralPath $orchestrationFile) {
            $orchestration = Read-Json $orchestrationFile
            Write-Output "base commit : $($orchestration.base_commit)$(if ($orchestration.base_commit -ne $orchestration.head) { " (includes uncommitted work; HEAD was $($orchestration.head))" })"
        }
    }
    foreach ($entry in $roster) {
        $delivery = $null
        $deliveryFile = Get-DeliveryFile $entry.id
        if (Test-Path -LiteralPath $deliveryFile) { $delivery = Read-Json $deliveryFile }
        Write-Output ''
        Write-Output "worker $($entry.id)"
        Write-Output "  status      : $($entry.status)"
        Write-Output "  delivery    : $($entry.delivery_status)"
        Write-Output "  worktree    : $(Get-WorkerWorktree $entry.id)$(if (Test-Path -LiteralPath (Get-WorkerWorktree $entry.id)) { '' } else { ' (missing)' })"
        if ($delivery) {
            Write-Output "  base commit : $($delivery.base_commit)"
            Write-Output "  patch sha   : $($delivery.patch_sha256)"
            Write-Output "  out_of_scope: $(@($delivery.ownership_findings.out_of_scope) -join ', ')"
            Write-Output "  overlap     : $(@($delivery.ownership_findings.overlap_with | ForEach-Object { $_.worker }) -join ', ')"
            if ($delivery.apply_error) { Write-Output "  apply note  : $($delivery.apply_error)" }
        }
    }
    foreach ($conflict in @($orchestration.conflicts)) {
        Write-Output ''
        Write-Output "open conflict: $($conflict.worker)"
        Write-Output "  reason : $($conflict.reason)"
        Write-Output "  paths  : $(@($conflict.paths) -join ', ')"
        Write-Output "  patch  : $($conflict.patch)"
    }
    if (Test-Path -LiteralPath $worktreeRoot -PathType Container) {
        $known = @($roster | ForEach-Object { $_.id })
        foreach ($stale in @(Get-ChildItem -LiteralPath $worktreeRoot -Directory | Where-Object { $known -notcontains $_.Name })) {
            Write-Output ''
            Write-Output "stale worktree (reported only, not removed): $($stale.FullName)"
        }
    }
}

}

# Every action above ends with the last thing it happened to run, which is very often an
# internal `git` call via Invoke-Git - and PowerShell's automatic $LASTEXITCODE is process-wide,
# not scoped to that helper function. Without an explicit exit here, the process's own exit code
# silently mirrors whatever that last git invocation returned (e.g. a `git diff --quiet` probe
# used as a boolean check, which is 1 when there ARE differences), even though the action
# completed and printed success. Fail() already exits 1 explicitly on every error path, so
# reaching here means the action succeeded.
exit 0
