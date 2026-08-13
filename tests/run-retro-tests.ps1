$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$retro = Join-Path $root 'scripts\retro.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-retro-tests-' + [guid]::NewGuid().ToString('N'))
$state = Join-Path $sandbox 'state'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# A finding is only ever produced from a task that already passed the gate, so the fixtures are
# whole task files rather than loose parameters - if the section format drifts from task-gate.ps1
# these tests break, which is the point.
function New-FixTask([string]$Id, [string]$MissCategory = 'impact_surface', [string]$Classification = 'regression') {
    $miss = if ($MissCategory) { "`r`n- miss_category: $MissCategory" } else { '' }
    $lines = @(
        '---'
        "id: $Id"
        'project_id: 0123456789abcdef'
        'worktree_id: fedcba9876543210'
        'status: in_progress'
        'code_change: true'
        'change_kind: fix'
        'risk_flags: []'
        'created_at: 2026-08-13T12:00:00+08:00'
        'updated_at: 2026-08-13T12:00:00+08:00'
        '---'
        ''
        '# settlement double-credit'
        ''
        '## Retrospective result'
        '- introduced_by: 0123456789abcdef0123456789abcdef01234567'
        "- classification: $Classification$miss"
        '- gap_evidence: task 20260801-000000-earlier left Impact surface without the second caller'
        '- framework_change: pending'
        ''
    )
    $dir = Join-Path $sandbox "tasks\$Id"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Join-Path $dir 'task.md'
    [IO.File]::WriteAllText($path, ($lines -join "`r`n"), $utf8NoBom)
    return $path
}

function Invoke-Retro([hashtable]$Arguments) {
    $splat = @{ StateRoot = $state } + $Arguments
    return (& $retro @splat | Out-String) | ConvertFrom-Json
}

# Two PowerShell 5.1 quirks stack up on a List result, and both make a count assertion lie:
#   1. ConvertFrom-Json hands a JSON array to the pipeline as ONE object, so @(Invoke-Retro ...)
#      is an array holding a single array - Count is 1 however many findings came back.
#   2. ConvertTo-Json unwraps a single-element array into a bare JSON object, so a one-hit filter
#      comes back as a scalar, and PSCustomObject has no .Count at all.
# Piping through ForEach-Object fixes (1); call sites still wrap this in @() to fix (2).
function Invoke-RetroList([hashtable]$Arguments) {
    $parsed = Invoke-Retro $Arguments
    if ($null -eq $parsed) { return @() }
    return @($parsed | ForEach-Object { $_ })
}

New-Item -ItemType Directory -Force -Path $sandbox, $state | Out-Null
try {
    # Every fixture task carries project_id 0123456789abcdef and worktree_id fedcba9876543210
    # (see New-FixTask). project.json is what retro.ps1 uses to turn that pair into a real
    # filesystem path - without this fixture there is nothing to resolve `repo` against.
    $fixtureRepo = Join-Path $sandbox 'repo'
    New-Item -ItemType Directory -Force -Path (Join-Path $state 'projects\0123456789abcdef') | Out-Null
    $projectJson = [ordered]@{
        id = '0123456789abcdef'
        canonical_root = $fixtureRepo
        worktrees = @(@{ id = 'fedcba9876543210'; path = $fixtureRepo })
    }
    [IO.File]::WriteAllText((Join-Path $state 'projects\0123456789abcdef\project.json'), ($projectJson | ConvertTo-Json -Depth 6), $utf8NoBom)

    $schema = Get-Content -LiteralPath (Join-Path $root 'schemas\retro.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $threshold = $schema.x_agent_workflow.escalate_threshold
    Assert ($threshold -ge 2) 'escalate threshold must be at least 2, or every one-off becomes a framework change'

    # --- Record --------------------------------------------------------------
    $first = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-120000-first'); ProposedChange = 'task-gate.ps1 should require a caller count in Impact surface' }
    Assert $first.ok "recording a regression failed: $($first.error)"
    Assert ($first.id -match '^[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$') "finding id has the wrong shape: $($first.id)"
    Assert ($first.miss_category -eq 'impact_surface') 'Record did not read miss_category from the task'
    Assert ($first.occurrences -eq 1) "first occurrence was counted as $($first.occurrences)"
    Assert (-not $first.escalate) 'a single occurrence escalated to a framework change'

    $findingPath = Join-Path $state "retro\findings\$($first.id).md"
    Assert (Test-Path -LiteralPath $findingPath) "finding file was not written: $findingPath"
    $findingText = Get-Content -LiteralPath $findingPath -Raw -Encoding UTF8
    foreach ($field in @('task_id: 20260813-120000-first', 'miss_category: impact_surface', 'status: open')) {
        Assert ($findingText -match [regex]::Escape($field)) "finding file is missing $field"
    }
    Assert ($findingText -match 'task-gate\.ps1 should require a caller count') 'finding file did not keep the proposed change'
    # The whole point of this store is triaging findings that came from other repositories, so
    # `repo` has to be the working repository. Deriving it from the task path gives the tasks
    # directory instead - a value that looks plausible and is useless.
    Assert ($findingText -match [regex]::Escape("repo: `"$fixtureRepo`"")) "finding recorded the wrong repo (expected $fixtureRepo): $findingText"

    # Second, different task, same category: this is what "it happened again" means.
    $second = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-130000-second'); ProposedChange = 'same gap, second time' }
    Assert $second.ok "recording the second regression failed: $($second.error)"
    Assert ($second.occurrences -eq 2) "second occurrence was counted as $($second.occurrences)"
    Assert ($second.escalate) 'a repeat of the same miss_category did not escalate'

    # A different category counts on its own.
    $other = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-140000-third' 'test_gap'); ProposedChange = 'add a fixture' }
    Assert ($other.occurrences -eq 1) 'a different miss_category shared the first category count'
    Assert (-not $other.escalate) 'an unrelated category escalated'

    # Re-recording the same task must not inflate the count - the escalation threshold is the
    # whole mechanism, and a retried close would otherwise trip it on its own.
    $repeat = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-120000-first'); ProposedChange = 'task-gate.ps1 should require a caller count in Impact surface' }
    Assert ($repeat.id -eq $first.id) 're-recording the same task created a second finding'
    Assert ($repeat.occurrences -eq 2) "re-recording changed the count to $($repeat.occurrences)"

    # --- Record refuses what is not a framework gap --------------------------
    $notRegression = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-150000-old' 'impact_surface' 'pre_existing'); ProposedChange = 'x' }
    Assert (-not $notRegression.ok) 'a pre_existing finding was recorded as a framework gap'
    Assert ($notRegression.error -match 'regression') 'Record did not explain that only regressions are recorded'

    $noCategory = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-160000-nocat' ''); ProposedChange = 'x' }
    Assert (-not $noCategory.ok) 'a regression without a miss_category was recorded'

    $badCategory = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-170000-bad' 'someone_was_careless'); ProposedChange = 'x' }
    Assert (-not $badCategory.ok) 'an off-vocabulary miss_category was recorded'
    Assert ($badCategory.error -match 'miss_category') 'Record did not name miss_category as the problem'

    # A proposal that names nothing actionable is the failure mode this whole loop exists to avoid.
    $noProposal = Invoke-Retro @{ Action = 'Record'; TaskPath = (New-FixTask '20260813-180000-vague') }
    Assert (-not $noProposal.ok) 'a finding without a proposed change was recorded'

    # --- List ----------------------------------------------------------------
    $open = @(Invoke-RetroList @{ Action = 'List'; Status = 'open' })
    Assert ($open.Count -eq 3) "expected 3 open findings, got $($open.Count)"
    $byCategory = @(Invoke-RetroList @{ Action = 'List'; MissCategory = 'test_gap' })
    Assert ($byCategory.Count -eq 1) "expected 1 test_gap finding, got $($byCategory.Count)"
    Assert ($byCategory[0].task_id -eq '20260813-140000-third') 'List returned the wrong finding for the category filter'

    # --- Resolve -------------------------------------------------------------
    $resolved = Invoke-Retro @{ Action = 'Resolve'; Id = $first.id; Status = 'applied'; Note = 'impact-guard now checks the caller count' }
    Assert $resolved.ok "resolving a finding failed: $($resolved.error)"
    $stillOpen = @(Invoke-RetroList @{ Action = 'List'; Status = 'open' })
    Assert ($stillOpen.Count -eq 2) "resolving did not remove the finding from the open list ($($stillOpen.Count) left)"
    $appliedText = Get-Content -LiteralPath $findingPath -Raw -Encoding UTF8
    Assert ($appliedText -match 'status: applied') 'the finding file still says open'
    Assert ($appliedText -match 'impact-guard now checks the caller count') 'the resolution note was not kept'

    $missing = Invoke-Retro @{ Action = 'Resolve'; Id = '20260101-000000-deadbeef'; Status = 'applied' }
    Assert (-not $missing.ok) 'resolving an unknown id reported success'

    # --- repo resolution ------------------------------------------------------
    # A worktree_id that was never registered (or was registered and then dropped) still has a
    # project - canonical_root is the fallback, not a hard failure.
    $fallbackRepoTask = New-FixTask '20260813-190000-fallback'
    $fallbackContent = (Get-Content -LiteralPath $fallbackRepoTask -Raw) -replace 'worktree_id: fedcba9876543210', 'worktree_id: 1111222233334444'
    [IO.File]::WriteAllText($fallbackRepoTask, $fallbackContent, $utf8NoBom)
    $fallbackResult = Invoke-Retro @{ Action = 'Record'; TaskPath = $fallbackRepoTask; ProposedChange = 'x' }
    Assert $fallbackResult.ok "recording with an unregistered worktree_id failed: $($fallbackResult.error)"
    $fallbackText = Get-Content -LiteralPath (Join-Path $state "retro\findings\$($fallbackResult.id).md") -Raw -Encoding UTF8
    Assert ($fallbackText -match [regex]::Escape("repo: `"$fixtureRepo`"")) "an unregistered worktree_id did not fall back to canonical_root: $fallbackText"

    # A project_id with no project.json at all (e.g. state root wiped, or a hand-built task) must
    # not crash Record - the finding is still worth having even with an empty repo field.
    $noProjectTask = New-FixTask '20260813-200000-noproject'
    $noProjectContent = (Get-Content -LiteralPath $noProjectTask -Raw) -replace 'project_id: 0123456789abcdef', 'project_id: ffffeeeeddddcccc'
    [IO.File]::WriteAllText($noProjectTask, $noProjectContent, $utf8NoBom)
    $noProjectResult = Invoke-Retro @{ Action = 'Record'; TaskPath = $noProjectTask; ProposedChange = 'x' }
    Assert $noProjectResult.ok "recording with an unresolvable project_id failed: $($noProjectResult.error)"
    $noProjectText = Get-Content -LiteralPath (Join-Path $state "retro\findings\$($noProjectResult.id).md") -Raw -Encoding UTF8
    Assert ($noProjectText -match 'repo:\s*""') "an unresolvable project_id should record an empty repo, not fabricate one: $noProjectText"

    # --- a damaged index must not silently reset the counters ----------------
    $indexPath = Join-Path $state 'retro\index.json'
    $goodIndex = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
    [IO.File]::WriteAllText($indexPath, '{ this is not json', $utf8NoBom)
    $damaged = Invoke-Retro @{ Action = 'List' }
    Assert (-not $damaged.ok) 'a corrupt index was treated as an empty store'
    [IO.File]::WriteAllText($indexPath, $goodIndex, $utf8NoBom)
    $restored = @(Invoke-RetroList @{ Action = 'List'; Status = 'open' })
    Assert ($restored.Count -eq 4) 'restoring the index did not restore the open findings'

    Write-Output 'retro tests passed'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
