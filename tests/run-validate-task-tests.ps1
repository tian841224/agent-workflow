$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$validator = Join-Path $root 'scripts\validate-task.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-validate-task-tests-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# Builds a frontmatter-only task file; $Extra lines are appended inside the frontmatter block.
function New-Task([string[]]$Extra, [string]$CodeChange = 'true') {
    $lines = @(
        '---'
        'id: 20260812-120000-sample'
        'project_id: 0123456789abcdef'
        'worktree_id: fedcba9876543210'
        'status: in_progress'
        "code_change: $CodeChange"
        'risk_flags: []'
        'created_at: 2026-08-12T12:00:00+08:00'
        'updated_at: 2026-08-12T12:00:00+08:00'
    ) + $Extra + @('---', '', '# sample', '')
    $path = Join-Path $sandbox ('task-' + [guid]::NewGuid().ToString('N') + '.md')
    [IO.File]::WriteAllText($path, ($lines -join "`r`n"), $utf8NoBom)
    return $path
}

function Get-Result([string[]]$Extra, [string]$CodeChange = 'true') {
    $path = New-Task $Extra $CodeChange
    return (& $validator -TaskPath $path | Out-String) | ConvertFrom-Json
}

function Assert-Invalid([string[]]$Extra, [string]$ExpectedError, [string]$Message, [string]$CodeChange = 'true') {
    $result = Get-Result $Extra $CodeChange
    Assert (-not $result.valid) "$Message (expected invalid, got valid)"
    Assert (@($result.errors) -match $ExpectedError) "$Message (errors were: $(@($result.errors) -join '; '))"
}

New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
try {
    # A plain task without subtask_role must be completely unaffected by the orchestration rules.
    $plain = Get-Result @()
    Assert $plain.valid "plain task rejected: $(@($plain.errors) -join '; ')"

    $workerBase = @(
        'subtask_role: worker'
        'parent_task_id: 20260812-110000-coordinator'
        'base_commit: 0123456789abcdef0123456789abcdef01234567'
        'file_ownership: [src/payment/, tests/payment/]'
        'delivery_status: pending'
    )
    $worker = Get-Result $workerBase
    Assert $worker.valid "valid worker task rejected: $(@($worker.errors) -join '; ')"
    Assert (@($worker.file_ownership).Count -eq 2) 'file_ownership was not parsed into two entries'
    Assert (@($worker.file_ownership)[0] -eq 'src/payment/') 'file_ownership entries were not trimmed'

    $coordinator = Get-Result @('subtask_role: coordinator', 'integration_status: pending')
    Assert $coordinator.valid "valid coordinator task rejected: $(@($coordinator.errors) -join '; ')"

    Assert-Invalid @('subtask_role: helper') 'invalid subtask_role' 'unknown subtask_role accepted'

    # Conditional required fields: the schema keeps them optional for old tasks, the validator does not.
    Assert-Invalid ($workerBase | Where-Object { $_ -notmatch '^parent_task_id' }) 'parent_task_id' 'worker without parent_task_id accepted'
    Assert-Invalid ($workerBase | Where-Object { $_ -notmatch '^file_ownership' }) 'file_ownership' 'worker without file_ownership accepted'
    Assert-Invalid ($workerBase | Where-Object { $_ -notmatch '^delivery_status' }) 'delivery_status' 'worker without delivery_status accepted'
    Assert-Invalid ($workerBase | Where-Object { $_ -notmatch '^base_commit' }) 'base_commit' 'worker without base_commit accepted'
    Assert-Invalid @('subtask_role: coordinator') 'integration_status' 'coordinator without integration_status accepted'

    # base_commit doubles as the Reviewer's diff base, so a short or malformed sha is not usable.
    Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^base_commit: .*$', 'base_commit: 0123abc' }) 'base_commit' 'short base_commit accepted'
    Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^base_commit: .*$', 'base_commit: zzzz456789abcdef0123456789abcdef01234567' }) 'base_commit' 'non-hex base_commit accepted'

    # Merged deliveries (resolved by hand after an apply conflict) are a terminal delivery state.
    $merged = Get-Result ($workerBase | ForEach-Object { $_ -replace '^delivery_status: pending$', 'delivery_status: merged' })
    Assert $merged.valid "delivery_status merged rejected: $(@($merged.errors) -join '; ')"
    $conflicted = Get-Result @('subtask_role: coordinator', 'integration_status: conflicted')
    Assert $conflicted.valid "integration_status conflicted rejected: $(@($conflicted.errors) -join '; ')"
    Assert-Invalid @('subtask_role: coordinator', 'integration_status: partially_applied') 'integration_status' 'retired partially_applied still accepted'

    # A typo in a frontmatter key would otherwise be read as "field absent" and silently ignored.
    Assert-Invalid @('subtask_rol: worker') 'unknown field' 'unknown frontmatter field accepted'

    # A worker must not be able to opt out of Reviewer/Verifier by flipping code_change.
    Assert-Invalid $workerBase 'code_change' 'worker with code_change false accepted' 'false'

    # Role-scoped fields must not leak across roles or onto plain tasks.
    Assert-Invalid @('subtask_role: coordinator', 'integration_status: pending', 'delivery_status: pending') 'delivery_status' 'coordinator carrying delivery_status accepted'
    Assert-Invalid ($workerBase + @('integration_status: pending')) 'integration_status' 'worker carrying integration_status accepted'
    Assert-Invalid @('file_ownership: [src/a/]') 'subtask_role' 'plain task carrying file_ownership accepted'

    Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^delivery_status: pending$', 'delivery_status: done' }) 'delivery_status' 'unknown delivery_status accepted'
    Assert-Invalid @('subtask_role: coordinator', 'integration_status: half') 'integration_status' 'unknown integration_status accepted'
    Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^parent_task_id: .*$', 'parent_task_id: not-a-task-id' }) 'parent_task_id' 'malformed parent_task_id accepted'

    # --- change_kind ---------------------------------------------------------
    # Drives the retrospective gate. It stays optional in the schema so the existing task corpus
    # and orchestrate.ps1's worker frontmatter keep validating; task-gate.ps1 is what demands it
    # on a code change. The validator's only job here is rejecting a value outside the enum.
    foreach ($kind in @('fix', 'feature', 'refactor', 'chore')) {
        $kindResult = Get-Result @("change_kind: $kind")
        Assert $kindResult.valid "change_kind $kind rejected: $(@($kindResult.errors) -join '; ')"
        Assert ($kindResult.change_kind -eq $kind) "validator did not surface change_kind $kind"
    }
    Assert-Invalid @('change_kind: bugfix') 'change_kind' 'unknown change_kind accepted'
    # Casing is deliberately not enforced: -contains is case-insensitive for status,
    # subtask_role and delivery_status too, and task-gate.ps1 matches change_kind against
    # retrospective_required the same way, so "Fix" still triggers the retrospective.
    $casedKind = Get-Result @('change_kind: Fix')
    Assert $casedKind.valid "differently-cased change_kind rejected: $(@($casedKind.errors) -join '; ')"
    # Absence must stay valid: this is the whole reason the field is not in schema.required.
    $noKind = Get-Result @()
    Assert $noKind.valid "task without change_kind rejected: $(@($noKind.errors) -join '; ')"
    Assert (-not $noKind.change_kind) 'validator invented a change_kind for a task that has none'
    # A worker may carry it (inherited by hand) but is never required to.
    $workerKind = Get-Result ($workerBase + @('change_kind: fix'))
    Assert $workerKind.valid "worker task with change_kind rejected: $(@($workerKind.errors) -join '; ')"

    # file_ownership grammar. validate-task.ps1 parses single-line scalars only, so a block
    # array silently reads as empty - it has to be rejected explicitly.
    Assert-Invalid (@('subtask_role: worker','parent_task_id: 20260812-110000-coordinator','delivery_status: pending','file_ownership:','  - src/payment/')) 'file_ownership' 'block-array file_ownership accepted'
    Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^file_ownership: .*$', 'file_ownership: []' }) 'file_ownership' 'empty file_ownership accepted'

    $badEntries = @{
        'C:/src/'          = 'absolute path'
        '/src/'            = 'rooted path'
        './src/'           = 'dot-slash prefix'
        '../src/'          = 'parent traversal'
        'src/../etc/'      = 'embedded parent traversal'
        'src\payment\'     = 'backslash separator'
    }
    foreach ($entry in $badEntries.Keys) {
        $line = "file_ownership: [$entry]"
        Assert-Invalid ($workerBase | ForEach-Object { $_ -replace '^file_ownership: .*$', [regex]::Escape($line).Replace('\ ', ' ') }) 'file_ownership' "invalid ownership entry accepted: $($badEntries[$entry])"
    }

    # --- split-plan.ps1 ------------------------------------------------------
    # The split conditions are prose in orchestration.md; this is what enforces them.

    $splitPlan = Join-Path $root 'scripts\split-plan.ps1'

    function New-CoordinatorTask([string]$Frozen = '2026-08-13T10:00:00+08:00', [string]$Role = 'coordinator') {
        $lines = @(
            '---'
            'id: 20260813-100000-coordinator'
            'project_id: 0123456789abcdef'
            'worktree_id: fedcba9876543210'
            'status: in_progress'
            'code_change: true'
            'risk_flags: []'
            'created_at: 2026-08-13T10:00:00+08:00'
            'updated_at: 2026-08-13T10:00:00+08:00'
            "frozen_at: $Frozen"
            "subtask_role: $Role"
            'integration_status: pending'
            '---'
            ''
            '# coordinator'
            ''
        )
        $path = Join-Path $sandbox ('coord-' + [guid]::NewGuid().ToString('N') + '.md')
        [IO.File]::WriteAllText($path, ($lines -join "`r`n"), $utf8NoBom)
        return $path
    }

    function Get-Eligibility([hashtable]$Plan, [string]$TaskPath = '') {
        if (-not $TaskPath) { $TaskPath = New-CoordinatorTask }
        $planPath = Join-Path $sandbox ('plan-' + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($planPath, ($Plan | ConvertTo-Json -Depth 8), $utf8NoBom)
        return (& $splitPlan -CoordinatorTaskPath $TaskPath -PlanPath $planPath | Out-String) | ConvertFrom-Json
    }

    function New-Plan([hashtable]$Override = @{}) {
        $plan = @{
            user_confirmed = $true
            shared_persistent_state = $false
            has_order_dependency = $false
            workers = @(
                @{ id = 'payment'; title = 'payment flow'; estimated_units = 3; file_ownership = @('src/payment/', 'tests/payment/') }
                @{ id = 'report'; title = 'report export'; estimated_units = 2; file_ownership = @('src/report/') }
            )
        }
        foreach ($key in $Override.Keys) { $plan[$key] = $Override[$key] }
        return $plan
    }

    function Assert-Ineligible([hashtable]$Plan, [string]$ExpectedError, [string]$Message, [string]$TaskPath = '') {
        $result = Get-Eligibility $Plan $TaskPath
        Assert (-not $result.eligible) "$Message (expected ineligible, got eligible)"
        Assert (@($result.errors) -match $ExpectedError) "$Message (errors were: $(@($result.errors) -join '; '))"
    }

    $ok = Get-Eligibility (New-Plan)
    Assert $ok.eligible "valid split plan rejected: $(@($ok.errors) -join '; ')"
    Assert (@($ok.workers).Count -eq 2) 'split-plan did not return the worker list'

    Assert-Ineligible (New-Plan @{ user_confirmed = $false }) 'user_confirmed' 'unconfirmed split accepted'
    Assert-Ineligible (New-Plan @{ shared_persistent_state = $true }) 'shared persistent state' 'split with shared state accepted'
    Assert-Ineligible (New-Plan @{ has_order_dependency = $true }) 'ordering dependency' 'split with an ordering dependency accepted'
    Assert-Ineligible (New-Plan @{ workers = @(@{ id = 'solo'; title = 'solo'; estimated_units = 5; file_ownership = @('src/solo/') }) }) 'at least two workers' 'single-worker split accepted'
    Assert-Ineligible (New-Plan) 'must be frozen' 'unfrozen coordinator split accepted' (New-CoordinatorTask '')
    Assert-Ineligible (New-Plan) 'subtask_role' 'non-coordinator task split accepted' (New-CoordinatorTask '2026-08-13T10:00:00+08:00' 'worker')

    Assert-Ineligible (New-Plan @{ workers = @(
        @{ id = 'a'; title = 'a'; estimated_units = 3; file_ownership = @('src/') }
        @{ id = 'b'; title = 'b'; estimated_units = 3; file_ownership = @('src/payment/') }
    ) }) 'overlaps' 'nested ownership prefixes accepted'
    Assert-Ineligible (New-Plan @{ workers = @(
        @{ id = 'a'; title = 'a'; estimated_units = 3; file_ownership = @('src/payment/') }
        @{ id = 'b'; title = 'b'; estimated_units = 3; file_ownership = @('src/payment/') }
    ) }) 'overlaps' 'identical ownership prefixes accepted'
    Assert-Ineligible (New-Plan @{ workers = @(
        @{ id = 'a'; title = 'a'; estimated_units = 3; file_ownership = @('src/payment/') }
        @{ id = 'b'; title = 'b'; estimated_units = 1; file_ownership = @('src/report/') }
    ) }) 'minimum split size' 'undersized worker accepted'
    Assert-Ineligible (New-Plan @{ workers = @(
        @{ id = 'Payment'; title = 'a'; estimated_units = 3; file_ownership = @('src/payment/') }
        @{ id = 'report'; title = 'b'; estimated_units = 3; file_ownership = @('src/report/') }
    ) }) 'worker id' 'uppercase worker id accepted'
    Assert-Ineligible (New-Plan @{ workers = @(
        @{ id = 'dup'; title = 'a'; estimated_units = 3; file_ownership = @('src/a/') }
        @{ id = 'dup'; title = 'b'; estimated_units = 3; file_ownership = @('src/b/') }
    ) }) 'duplicated' 'duplicate worker id accepted'

    # Default-serial surfaces. The last-segment-only check that shipped in the V5 prototype let
    # src/api/routes.ts through, because its final segment is "routes.ts" rather than "routes".
    foreach ($serial in @('src/api/routes.ts', 'src/routes/', 'src/schema/', 'db/migrations/', 'package-lock.json', 'src/index.ts', 'src/i18n/')) {
        Assert-Ineligible (New-Plan @{ workers = @(
            @{ id = 'a'; title = 'a'; estimated_units = 3; file_ownership = @($serial) }
            @{ id = 'b'; title = 'b'; estimated_units = 3; file_ownership = @('src/report/') }
        ) }) 'default-serial' "default-serial surface accepted: $serial"
    }

    # Ownership grammar must match validate-task.ps1 exactly, or Init writes a worker task that
    # its own validator rejects.
    foreach ($bad in @('C:/src/', '/src/', './src/', '../src/', 'src\payment\')) {
        Assert-Ineligible (New-Plan @{ workers = @(
            @{ id = 'a'; title = 'a'; estimated_units = 3; file_ownership = @($bad) }
            @{ id = 'b'; title = 'b'; estimated_units = 3; file_ownership = @('src/report/') }
        ) }) 'ownership' "invalid ownership entry accepted: $bad"
    }

    # An unparseable plan must fail loudly, not be reported as "0 workers".
    $brokenPlanPath = Join-Path $sandbox 'broken-plan.json'
    [IO.File]::WriteAllText($brokenPlanPath, '{ not json', $utf8NoBom)
    $broken = (& $splitPlan -CoordinatorTaskPath (New-CoordinatorTask) -PlanPath $brokenPlanPath | Out-String) | ConvertFrom-Json
    Assert (-not $broken.eligible) 'malformed split plan was accepted'
    Assert (@($broken.errors).Count -gt 0) 'malformed split plan produced no error'

    Write-Output 'validate-task and split-plan tests passed'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
