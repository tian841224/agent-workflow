$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$resolver = Join-Path $root 'scripts\project-resolver.ps1'
$checkTask = Join-Path $root 'scripts\check-task.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-orchestrate-tests-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# orchestrate.ps1 calls `exit`; invoked via the call operator that would tear down this whole
# test process, so it must run as a real child process, the same way run-pre-review-tests.ps1
# invokes pre-review.ps1.
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-Text([string]$Path, [string]$Content) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Write-Bytes([string]$Path, [byte[]]$Bytes) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllBytes($Path, $Bytes)
}

function Invoke-Json([string]$Script, [hashtable]$Splat) {
    return (& $Script @Splat | Out-String) | ConvertFrom-Json
}

# A repo whose HEAD exists and whose tree is clean.
function New-Repo([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    & git -C $Path init --quiet 2>&1 | Out-Null
    & git -C $Path config user.email 'test@example.com'
    & git -C $Path config user.name 'test'
    & git -C $Path config core.autocrlf false
    Write-Text (Join-Path $Path 'src\payment\service.txt') "payment v1`n"
    Write-Text (Join-Path $Path 'src\report\service.txt') "report v1`n"
    & git -C $Path add -A 2>&1 | Out-Null
    & git -C $Path commit -m init --quiet 2>&1 | Out-Null
    return (& git -C $Path rev-parse HEAD).Trim()
}

function New-TaskFile([string]$Path, [hashtable]$Front, [string]$Body) {
    $lines = @('---')
    foreach ($key in $Front.Keys) { $lines += "$($key): $($Front[$key])" }
    # Split on \r?\n, not \n: this file is CRLF, so its here-strings already contain \r\n and a
    # bare \n split leaves a trailing \r on every element, which then rejoins to \r\r\n. The
    # doubled \r silently defeats the `[ \t]*\r?$` anchors the gates use.
    $lines += @('---', '') + ($Body -split "`r?`n")
    Write-Text $Path (($lines -join "`r`n") + "`r`n")
}

# Frontmatter for a worker task that has genuinely finished its workflow.
function Get-WorkerFront([string]$Id, [string]$ProjectId, [string]$WorktreeId, [string]$Parent, [string]$Ownership, [string]$Status = 'done', [string]$Delivery = 'pending', [string]$Base = '0123456789abcdef0123456789abcdef01234567') {
    return [ordered]@{
        id = $Id; project_id = $ProjectId; worktree_id = $WorktreeId; status = $Status
        code_change = 'true'; risk_flags = '[]'
        created_at = '2026-08-12T12:00:00+08:00'; updated_at = '2026-08-12T12:00:00+08:00'
        subtask_role = 'worker'; parent_task_id = $Parent; base_commit = $Base
        file_ownership = $Ownership; delivery_status = $Delivery
    }
}

# The split plan replaces the old -Worker slug:prefix CLI spec: split-plan.ps1 checks it and
# Init refuses to create anything unless it comes back eligible.
function New-SplitPlan([string]$Path, [object[]]$Workers, [hashtable]$Override = @{}) {
    $plan = [ordered]@{
        user_confirmed = $true
        shared_persistent_state = $false
        has_order_dependency = $false
        workers = @($Workers)
    }
    foreach ($key in $Override.Keys) { $plan[$key] = $Override[$key] }
    Write-Text $Path ($plan | ConvertTo-Json -Depth 8)
    return $Path
}

function New-WorkerPlan([string]$Id, [string[]]$Ownership, [int]$Units = 3) {
    return [ordered]@{ id = $Id; title = "$Id work"; estimated_units = $Units; file_ownership = @($Ownership) }
}

function Get-WorkerBody([string]$Parent) {
    return @"
## Goal
ship it

## Scope
one feature

## Completion criteria
- [x] done

## Validation results
- pre-review: SKIP
- command: n/a
- checks: n/a
- skip reason: sandbox fixture
- limitations: none

## Parent task
$Parent

## File ownership
declared prefixes

## Impact surface
- callers: none
- entrypoints: none
- shared state: none
- unverified nodes: none

## Execution path and regression evidence
entry > change > end

## Reviewer result
- result: PASS
- Architecture consistency: PASS
- Code quality and conventions: PASS
- Data consistency: N/A no persistence
- Security: N/A no untrusted input
- Risk and compatibility: PASS
- Performance: N/A trivial
- Flow and impact completeness: PASS

## Verifier result
- PASS
"@
}

New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
try {
    $repo = Join-Path $sandbox 'repo'
    $state = Join-Path $sandbox 'state'
    $head = New-Repo $repo
    $resolved = Invoke-Json $resolver @{ Path = $repo; StateRoot = $state; Ensure = $true }
    $projectId = $resolved.project_id
    Assert ($resolved.is_git) 'sandbox repo was not detected as a git repo'

    # --- project-resolver: batch worktree registration ---

    $wtA = Join-Path $sandbox 'wt-a'
    $wtB = Join-Path $sandbox 'wt-b'
    & git -C $repo worktree add --detach $wtA $head --quiet 2>&1 | Out-Null
    & git -C $repo worktree add --detach $wtB $head --quiet 2>&1 | Out-Null

    $registered = Invoke-Json $resolver @{ Path = $repo; StateRoot = $state; RegisterWorktree = @($wtA, $wtB) }
    Assert (@($registered.registered_worktrees).Count -eq 2) 'RegisterWorktree did not report both worktrees'

    $projectFile = Join-Path $state "projects\$projectId\project.json"
    $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($project.worktrees).Count -eq 3) "project.json should hold the main worktree plus two workers, got $(@($project.worktrees).Count)"

    # The registered id must equal what the resolver computes from inside that worktree,
    # otherwise the worker can never find its own task.
    $fromInside = Invoke-Json $resolver @{ Path = $wtA; StateRoot = $state }
    $registeredA = @($registered.registered_worktrees | Where-Object { $_.path -eq (Resolve-Path $wtA).Path })
    Assert ($registeredA.Count -eq 1) 'worker worktree A was not registered under its resolved path'
    Assert ($registeredA[0].id -eq $fromInside.worktree_id) 'registered worktree_id does not match the id resolved inside the worktree'
    Assert ($fromInside.project_id -eq $projectId) 'worker worktree resolved to a different project'

    # Re-registering must stay idempotent rather than duplicating entries.
    Invoke-Json $resolver @{ Path = $repo; StateRoot = $state; RegisterWorktree = @($wtA) } | Out-Null
    $project = Get-Content -LiteralPath $projectFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($project.worktrees).Count -eq 3) 'RegisterWorktree duplicated an existing worktree entry'

    # --- project-resolver: roster query ---

    $coordinatorId = '20260812-100000-coordinator'
    $workerAId = '20260812-100100-worker-a'
    $workerBId = '20260812-100200-worker-b'
    $strayId = '20260812-100300-unrelated'
    $taskRoot = Join-Path $state "projects\$projectId\tasks"
    $idB = (Invoke-Json $resolver @{ Path = $wtB; StateRoot = $state }).worktree_id

    # wt-a/wt-b (above) intentionally use arbitrary names to test batch registration in
    # isolation. check-task -Mode Worker additionally requires the task id to match its
    # registered worktree's directory name (real orchestrate.ps1 Init always names worker
    # worktrees after the worker's own task id) - worker A needs a worktree that actually
    # satisfies that, separate from the arbitrary-named wt-a used above.
    $wtWorkerA = Join-Path $sandbox $workerAId
    & git -C $repo worktree add --detach $wtWorkerA $head --quiet 2>&1 | Out-Null
    Invoke-Json $resolver @{ Path = $repo; StateRoot = $state; RegisterWorktree = @($wtWorkerA) } | Out-Null
    $idA = (Invoke-Json $resolver @{ Path = $wtWorkerA; StateRoot = $state }).worktree_id

    # check-task -Mode Worker verifies parent_task_id resolves to a real coordinator task (not
    # just a well-formed id string) - the fixture must create one, or every worker check below
    # would fail on the identity contract before reaching what each test actually targets.
    New-TaskFile (Join-Path $taskRoot "$coordinatorId\task.md") ([ordered]@{
        id = $coordinatorId; project_id = $projectId; worktree_id = $resolved.worktree_id; status = 'in_progress'
        code_change = 'true'; risk_flags = '[]'
        created_at = '2026-08-12T10:00:00+08:00'; updated_at = '2026-08-12T10:00:00+08:00'
        subtask_role = 'coordinator'; integration_status = 'pending'
    }) "## Goal`ng`n## Scope`ns`n## Completion criteria`n- [ ] c`n"

    New-TaskFile (Join-Path $taskRoot "$workerBId\task.md") (Get-WorkerFront $workerBId $projectId $idB $coordinatorId '[src/report/]') (Get-WorkerBody $coordinatorId)
    New-TaskFile (Join-Path $taskRoot "$workerAId\task.md") (Get-WorkerFront $workerAId $projectId $idA $coordinatorId '[src/payment/]') (Get-WorkerBody $coordinatorId)
    New-TaskFile (Join-Path $taskRoot "$strayId\task.md") (Get-WorkerFront $strayId $projectId $idB '20260101-000000-other' '[src/other/]') (Get-WorkerBody '20260101-000000-other')

    $roster = Invoke-Json $resolver @{ Path = $repo; StateRoot = $state; RosterFor = $coordinatorId }
    $rosterIds = @($roster.roster | ForEach-Object { $_.id })
    Assert ($rosterIds.Count -eq 2) "roster should contain exactly the two workers, got $($rosterIds -join ',')"
    Assert ($rosterIds[0] -eq $workerAId -and $rosterIds[1] -eq $workerBId) "roster is not sorted by task id: $($rosterIds -join ',')"
    Assert (-not ($rosterIds -contains $strayId)) 'roster leaked a task belonging to another coordinator'

    # active_tasks must stay scoped to the current worktree - the roster is a separate query.
    # The coordinator's own task legitimately IS the main worktree's active task; what must
    # never happen is a WORKER task (a different worktree_id) leaking into this list.
    Assert (@($roster.active_tasks).Count -eq 1 -and $roster.active_tasks[0] -match [regex]::Escape($coordinatorId)) 'only the coordinator''s own task should be the main worktree''s active task'

    # --- check-task -Mode Worker ---

    $workerTaskA = Join-Path $taskRoot "$workerAId\task.md"
    $okWorker = Invoke-Json $checkTask @{ TaskPath = $workerTaskA; Mode = 'Worker'; StateRoot = $state }
    Assert ($okWorker.valid) "a finished worker task was rejected: $(@($okWorker.issues) -join '; ')"

    # A worker that has not finished must not be collectable.
    $notDoneId = '20260812-100400-worker-wip'
    $notDone = Join-Path $taskRoot "$notDoneId\task.md"
    New-TaskFile $notDone (Get-WorkerFront $notDoneId $projectId $idB $coordinatorId '[src/report/]' 'in_progress') (Get-WorkerBody $coordinatorId)
    $wip = Invoke-Json $checkTask @{ TaskPath = $notDone; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $wip.valid) 'check-task accepted a worker that is not done'
    Assert (@($wip.issues) -match 'done') 'check-task did not explain that the worker must be done'

    # Worker mode must never require delivery metadata: at worker stop time it does not exist yet.
    Assert (-not (@($okWorker.issues) -match 'delivery\.json')) 'check-task -Mode Worker must not inspect delivery metadata'

    # A fake-done worker with no Reviewer/Verifier evidence must be rejected before any patch is built.
    $fakeId = '20260812-100500-worker-fake'
    $fake = Join-Path $taskRoot "$fakeId\task.md"
    $fakeBody = (Get-WorkerBody $coordinatorId) -replace '(?ms)## Reviewer result.*$', "## Reviewer result`n`n## Verifier result`n"
    New-TaskFile $fake (Get-WorkerFront $fakeId $projectId $idB $coordinatorId '[src/report/]') $fakeBody
    $fakeResult = Invoke-Json $checkTask @{ TaskPath = $fake; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $fakeResult.valid) 'check-task accepted a worker without Reviewer and Verifier evidence'

    # --- check-task -Mode Worker: identity contract ---
    # A well-formed parent_task_id/worktree_id/id is not enough on its own; each must actually
    # resolve to something real, or a worker could detach itself from any coordinator's roster
    # (dangling parent_task_id) or masquerade as belonging to the wrong project/worktree.

    $ghostParentId = '20260812-100600-worker-ghost-parent'
    $ghostParent = Join-Path $taskRoot "$ghostParentId\task.md"
    New-TaskFile $ghostParent (Get-WorkerFront $ghostParentId $projectId $idA '20261231-999999-nonexistent' '[src/payment/]') (Get-WorkerBody '20261231-999999-nonexistent')
    $ghostParentResult = Invoke-Json $checkTask @{ TaskPath = $ghostParent; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $ghostParentResult.valid) 'check-task accepted a worker whose parent_task_id does not resolve to any real task'
    Assert (@($ghostParentResult.issues) -match 'does not resolve') 'check-task did not explain the dangling parent_task_id'

    $notCoordParentId = '20260812-100700-worker-noncoord-parent'
    $notCoordParent = Join-Path $taskRoot "$notCoordParentId\task.md"
    # workerBId is itself a WORKER task, not a coordinator - pointing another worker's parent at it must fail.
    New-TaskFile $notCoordParent (Get-WorkerFront $notCoordParentId $projectId $idA $workerBId '[src/payment/]') (Get-WorkerBody $workerBId)
    $notCoordParentResult = Invoke-Json $checkTask @{ TaskPath = $notCoordParent; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $notCoordParentResult.valid) 'check-task accepted a worker whose parent_task_id points to a non-coordinator task'
    Assert (@($notCoordParentResult.issues) -match 'coordinator') 'check-task did not explain that the parent is not a coordinator'

    $unregisteredId = '20260812-100800-worker-unregistered'
    $unregistered = Join-Path $taskRoot "$unregisteredId\task.md"
    New-TaskFile $unregistered (Get-WorkerFront $unregisteredId $projectId 'cafebabecafebabe' $coordinatorId '[src/payment/]') (Get-WorkerBody $coordinatorId)
    $unregisteredResult = Invoke-Json $checkTask @{ TaskPath = $unregistered; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $unregisteredResult.valid) 'check-task accepted a worker whose worktree_id was never registered'
    Assert (@($unregisteredResult.issues) -match 'not a registered worktree') 'check-task did not explain the unregistered worktree_id'

    $misnamedId = '20260812-100900-worker-misnamed'
    $misnamed = Join-Path $taskRoot "$misnamedId\task.md"
    # idB's worktree directory is named after workerBId, not this task - id/worktree mismatch.
    New-TaskFile $misnamed (Get-WorkerFront $misnamedId $projectId $idB $coordinatorId '[src/report/]') (Get-WorkerBody $coordinatorId)
    $misnamedResult = Invoke-Json $checkTask @{ TaskPath = $misnamed; Mode = 'Worker'; StateRoot = $state }
    Assert (-not $misnamedResult.valid) 'check-task accepted a worker whose task id does not match its worktree directory name'
    Assert (@($misnamedResult.issues) -match 'does not match its registered worktree') 'check-task did not explain the id/worktree name mismatch'

    # ---------------------------------------------------------------- lifecycle

    $orchestrate = Join-Path $root 'scripts\orchestrate.ps1'
    Assert (Test-Path -LiteralPath $orchestrate) 'scripts\orchestrate.ps1 is missing'

    function New-Lifecycle([string]$Name) {
        $lifeRoot = Join-Path $sandbox $Name
        $lifeRepo = Join-Path $lifeRoot 'repo'
        $lifeState = Join-Path $lifeRoot 'state'
        $lifeHead = New-Repo $lifeRepo
        $r = Invoke-Json $resolver @{ Path = $lifeRepo; StateRoot = $lifeState; Ensure = $true }
        $coordId = '20260812-090000-coord'
        $coordDir = Join-Path $lifeState "projects\$($r.project_id)\tasks\$coordId"
        New-TaskFile (Join-Path $coordDir 'task.md') ([ordered]@{
            id = $coordId; project_id = $r.project_id; worktree_id = $r.worktree_id; status = 'in_progress'
            code_change = 'true'; risk_flags = '[]'
            created_at = '2026-08-12T09:00:00+08:00'; updated_at = '2026-08-12T09:00:00+08:00'
            frozen_at = '2026-08-12T09:00:00+08:00'
            subtask_role = 'coordinator'; integration_status = 'pending'
        }) @"
## Goal
split it

## Scope
two features

## Completion criteria
- [ ] both applied

## Validation results
- pre-review: SKIP
- command: n/a
- checks: n/a
- skip reason: fixture
- limitations: none

## Decomposition plan
payment and report are disjoint

## Worker results
pending

## Delivery log
pending

## Integration verification
pending
"@
        return [pscustomobject]@{ Root = $lifeRoot; Repo = $lifeRepo; State = $lifeState; Head = $lifeHead; ProjectId = $r.project_id; CoordId = $coordId; CoordDir = $coordDir }
    }

    # 2>&1 on a native command wraps each stderr line as an ErrorRecord; with this script's
    # own $ErrorActionPreference = 'Stop', that promotes the child's stderr into a terminating
    # error here and aborts the whole test run instead of just failing one assertion. Relax the
    # preference only around the native call.
    function Invoke-Native([string]$Exe, [string[]]$NativeArgs) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $Exe @NativeArgs 2>&1
            return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($output | Out-String) }
        } finally { $ErrorActionPreference = $previous }
    }

    function Invoke-Orchestrate([object]$Ctx, [string]$Action, [hashtable]$Extra = @{}) {
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $orchestrate, '-Action', $Action, '-Path', $Ctx.Repo, '-StateRoot', $Ctx.State)
        foreach ($k in $Extra.Keys) {
            $psArgs += "-$k"; $psArgs += [string]$Extra[$k]
        }
        $result = Invoke-Native $hostExe $psArgs
        $script:LASTEXITCODE = $result.Code
        return $result.Text
    }

    function Get-DefaultPlan([object]$Ctx, [string]$Name = 'plan.json') {
        return New-SplitPlan (Join-Path $Ctx.Root $Name) @(
            (New-WorkerPlan 'payment' @('src/payment/')),
            (New-WorkerPlan 'report' @('src/report/'))
        )
    }

    # --- Init ---

    $ctx = New-Lifecycle 'life1'

    # Ineligible plans must be refused before any worktree exists.
    $overlapPlan = New-SplitPlan (Join-Path $ctx.Root 'overlap.json') @(
        (New-WorkerPlan 'a' @('src/')), (New-WorkerPlan 'b' @('src/payment/'))
    )
    $overlapOut = Invoke-Orchestrate $ctx 'Init' @{ PlanPath = $overlapPlan }
    Assert ($LASTEXITCODE -ne 0) 'Init accepted ownership prefixes that contain one another'
    Assert ($overlapOut -match 'overlaps') 'Init did not explain the ownership overlap'
    Assert (-not (Test-Path -LiteralPath (Join-Path $ctx.State "projects\$($ctx.ProjectId)\worktrees"))) 'Init created worktrees despite rejecting the split'

    # An untracked file inside a worker's ownership is invisible to that worker (git stash
    # create records tracked changes only) and would collide at Apply, so Init must refuse.
    Write-Text (Join-Path $ctx.Repo 'src\payment\untracked.txt') "not committed`n"
    $untrackedOut = Invoke-Orchestrate $ctx 'Init' @{ PlanPath = (Get-DefaultPlan $ctx) }
    Assert ($LASTEXITCODE -ne 0) 'Init accepted an untracked file inside declared ownership'
    Assert ($untrackedOut -match 'untracked\.txt') 'Init did not name the colliding untracked file'
    Remove-Item -LiteralPath (Join-Path $ctx.Repo 'src\payment\untracked.txt') -Force

    # A dirty tracked file is fine and is exactly what the stash-create base exists for: the
    # worker must be able to see the uncommitted work rather than build on a stale baseline.
    Write-Text (Join-Path $ctx.Repo 'src\payment\service.txt') "payment uncommitted`n"

    $initOut = Invoke-Orchestrate $ctx 'Init' @{ PlanPath = (Get-DefaultPlan $ctx) }
    Assert ($LASTEXITCODE -eq 0) "Init failed: $initOut"
    $ctx | Add-Member -NotePropertyName Base -NotePropertyValue ((Get-Content -LiteralPath (Join-Path $ctx.CoordDir 'orchestration.json') -Raw -Encoding UTF8 | ConvertFrom-Json).base_commit) -Force
    Assert ($ctx.Base -ne $ctx.Head) 'Init did not create a stash-create base for a dirty working tree'

    $worktreeRoot = Join-Path $ctx.State "projects\$($ctx.ProjectId)\worktrees"
    $created = @(Get-ChildItem -LiteralPath $worktreeRoot -Directory)
    Assert ($created.Count -eq 2) "Init should create two worktrees, found $($created.Count)"
    foreach ($w in $created) {
        Assert ((& git -C $w.FullName symbolic-ref -q HEAD 2>$null) -eq $null) "worker worktree $($w.Name) is not detached"
        Assert ((& git -C $w.FullName rev-parse HEAD).Trim() -eq $ctx.Base) "worker worktree $($w.Name) is not on the base commit"
        Assert (-not (& git -C $w.FullName status --porcelain)) "worker worktree $($w.Name) is not clean after Init"
    }
    # The whole point of the stash-create base: the uncommitted edit is present in the worktree.
    Assert ((Get-Content -LiteralPath (Join-Path $created[0].FullName 'src\payment\service.txt') -Raw) -match 'payment uncommitted') 'worker worktree cannot see the main tree''s uncommitted change'
    # Init must not disturb the main working tree, its index, or its refs.
    Assert ((& git -C $ctx.Repo rev-parse HEAD).Trim() -eq $ctx.Head) 'Init moved HEAD'
    Assert (-not (& git -C $ctx.Repo stash list)) 'Init left a stash entry behind'

    # A second Init must not silently start over on top of live workers.
    Invoke-Orchestrate $ctx 'Init' @{ PlanPath = (Get-DefaultPlan $ctx 'plan2.json') } | Out-Null
    Assert ($LASTEXITCODE -ne 0) 'Init ran twice for the same coordinator'
    $roster1 = Invoke-Json $resolver @{ Path = $ctx.Repo; StateRoot = $ctx.State; RosterFor = $ctx.CoordId }
    Assert (@($roster1.roster).Count -eq 2) 'Init did not create two worker tasks under the coordinator'
    foreach ($entry in @($roster1.roster)) {
        $insideId = (Invoke-Json $resolver @{ Path = (Join-Path $worktreeRoot $entry.id); StateRoot = $ctx.State }).worktree_id
        Assert ($entry.worktree_id -eq $insideId) "worker task $($entry.id) has a worktree_id that does not match its worktree"
        Assert ($entry.delivery_status -eq 'pending') "worker task $($entry.id) did not start with delivery_status pending"
    }

    # --- caller validation ---

    $workerIds = @($roster1.roster | ForEach-Object { $_.id })
    $workerPathA = Join-Path $worktreeRoot $workerIds[0]
    $callerApply = Invoke-Native $hostExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $orchestrate, '-Action', 'Apply', '-Path', $workerPathA, '-StateRoot', $ctx.State)
    Assert ($callerApply.Code -ne 0) 'a mutating action was allowed from a worker cwd'
    $callerStatus = Invoke-Native $hostExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $orchestrate, '-Action', 'Status', '-Path', $workerPathA, '-StateRoot', $ctx.State)
    Assert ($callerStatus.Code -eq 0) 'Status must stay available from a worker cwd'

    # --- Collect ---

    # A worker that is still in progress cannot be collected.
    $collectEarly = Invoke-Orchestrate $ctx 'Collect'
    Assert ($LASTEXITCODE -ne 0) 'Collect ran while workers were still in progress'

    function Complete-Worker([object]$Ctx, [string]$WorkerId, [scriptblock]$Edit) {
        $wt = Join-Path (Join-Path $Ctx.State "projects\$($Ctx.ProjectId)\worktrees") $WorkerId
        & $Edit $wt
        $taskFile = Join-Path $Ctx.State "projects\$($Ctx.ProjectId)\tasks\$WorkerId\task.md"
        $text = Get-Content -LiteralPath $taskFile -Raw -Encoding UTF8
        $text = $text -replace '(?m)^status: .*$', 'status: done'
        # Init scaffolds empty '## Impact surface' / Reviewer / Verifier headers; replace
        # everything from Impact surface onward with filled-in content instead of appending.
        $filled = ((Get-WorkerBody $Ctx.CoordId) -replace '(?ms)^.*?(## Impact surface.*)$', '$1').TrimEnd()
        $text = [regex]::Replace($text, '(?ms)## Impact surface.*$', $filled)
        [IO.File]::WriteAllText($taskFile, $text, $utf8NoBom)
    }

    Complete-Worker $ctx $workerIds[0] { param($wt) Write-Text (Join-Path $wt 'src\payment\service.txt') "payment v2`n"; Write-Text (Join-Path $wt 'src\payment\new.txt') "brand new`n" }
    Complete-Worker $ctx $workerIds[1] { param($wt) Write-Text (Join-Path $wt 'src\report\service.txt') "report v2`n" }

    $collectOut = Invoke-Orchestrate $ctx 'Collect'
    Assert ($LASTEXITCODE -eq 0) "Collect failed: $collectOut"
    foreach ($id in $workerIds) {
        $deliveryDir = Join-Path $ctx.State "projects\$($ctx.ProjectId)\tasks\$id"
        Assert (Test-Path -LiteralPath (Join-Path $deliveryDir 'delivery.patch')) "delivery.patch missing for $id"
        $delivery = Get-Content -LiteralPath (Join-Path $deliveryDir 'delivery.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert ($delivery.base_commit -eq $ctx.Base) "delivery.json for $id recorded the wrong base commit"
        Assert ($delivery.patch_sha256) "delivery.json for $id has no patch hash"
        Assert (@($delivery.ownership_findings.out_of_scope).Count -eq 0) "unexpected out_of_scope for $id"
    }
    # Untracked files must reach the patch, and Collect must not disturb the worker index.
    $patchA = Get-Content -LiteralPath (Join-Path $ctx.State "projects\$($ctx.ProjectId)\tasks\$($workerIds[0])\delivery.patch") -Raw -Encoding UTF8
    Assert ($patchA -match 'new\.txt') 'Collect did not include an untracked file in the patch'
    Assert (-not (& git -C (Join-Path $worktreeRoot $workerIds[0]) diff --cached --name-only)) 'Collect left staged entries in the worker index'

    # --- Apply ---

    # The fingerprints pin the main tree as it was at Init; a tree that moved must stop Apply
    # before anything is written.
    Write-Text (Join-Path $ctx.Repo 'src\report\service.txt') "meddled`n"
    $movedOut = Invoke-Orchestrate $ctx 'Apply'
    Assert ($LASTEXITCODE -ne 0) 'Apply ran after the main working tree changed since Init'
    Assert ($movedOut -match 'has changed since Init') 'Apply did not explain the baseline mismatch'
    Write-Text (Join-Path $ctx.Repo 'src\report\service.txt') "report v1`n"

    $applyOut = Invoke-Orchestrate $ctx 'Apply'
    Assert ($LASTEXITCODE -eq 0) "Apply failed: $applyOut"
    Assert ((Get-Content -LiteralPath (Join-Path $ctx.Repo 'src\payment\service.txt') -Raw) -match 'payment v2') 'Apply did not write the payment change'
    Assert ((Get-Content -LiteralPath (Join-Path $ctx.Repo 'src\report\service.txt') -Raw) -match 'report v2') 'Apply did not write the report change'
    Assert (Test-Path -LiteralPath (Join-Path $ctx.Repo 'src\payment\new.txt')) 'Apply did not create the added file'
    Assert ((& git -C $ctx.Repo rev-parse HEAD).Trim() -eq $ctx.Head) 'Apply moved HEAD'
    Assert ((& git -C $ctx.Repo rev-list --count HEAD) -eq '1') 'Apply created a commit'
    Assert (-not (& git -C $ctx.Repo diff --cached --name-only)) 'Apply staged changes into the index'
    Assert (@(& git -C $ctx.Repo branch --format '%(refname)').Count -le 1) 'Apply created a branch'

    # \r?$ throughout: task files are CRLF, and a bare $ anchor would never match.
    $coordText = Get-Content -LiteralPath (Join-Path $ctx.CoordDir 'task.md') -Raw -Encoding UTF8
    Assert ($coordText -match '(?m)^integration_status: applied[ \t]*\r?$') 'Apply did not set integration_status to applied'
    foreach ($id in $workerIds) {
        $t = Get-Content -LiteralPath (Join-Path $ctx.State "projects\$($ctx.ProjectId)\tasks\$id\task.md") -Raw -Encoding UTF8
        Assert ($t -match '(?m)^delivery_status: applied[ \t]*\r?$') "worker $id was not marked applied"
        Assert (@([regex]::Matches($t, '(?m)^delivery_status:')).Count -eq 1) "worker $id has duplicate delivery_status lines"
    }

    # --- Cleanup ---

    $extra = Join-Path $worktreeRoot "$($workerIds[0])\src\payment\late.txt"
    Write-Text $extra "added after collect`n"
    Invoke-Orchestrate $ctx 'Cleanup' | Out-Null
    Assert (Test-Path -LiteralPath (Join-Path $worktreeRoot $workerIds[0])) 'Cleanup removed a worktree whose content no longer matches the applied patch'
    Remove-Item -LiteralPath $extra -Force
    $cleanupOut = Invoke-Orchestrate $ctx 'Cleanup'
    Assert ($LASTEXITCODE -eq 0) "Cleanup failed: $cleanupOut"
    Assert (-not (Test-Path -LiteralPath (Join-Path $worktreeRoot $workerIds[0]))) 'Cleanup did not remove an applied worktree'
    Assert (-not (Test-Path -LiteralPath (Join-Path $worktreeRoot $workerIds[1]))) 'Cleanup did not remove the second applied worktree'

    # --- out_of_scope adjudication ---

    $ctx2 = New-Lifecycle 'life2'
    Invoke-Orchestrate $ctx2 'Init' @{ PlanPath = (Get-DefaultPlan $ctx2) } | Out-Null
    $ids2 = @((Invoke-Json $resolver @{ Path = $ctx2.Repo; StateRoot = $ctx2.State; RosterFor = $ctx2.CoordId }).roster | ForEach-Object { $_.id })
    # Both workers touch the same file: one stays inside its prefix, the other goes out of scope.
    Complete-Worker $ctx2 $ids2[0] { param($wt) Write-Text (Join-Path $wt 'src\payment\service.txt') "payment v2`n" }
    Complete-Worker $ctx2 $ids2[1] { param($wt) Write-Text (Join-Path $wt 'src\payment\service.txt') "payment other`n" }
    Invoke-Orchestrate $ctx2 'Collect' | Out-Null
    $d2 = Get-Content -LiteralPath (Join-Path $ctx2.State "projects\$($ctx2.ProjectId)\tasks\$($ids2[1])\delivery.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($d2.ownership_findings.out_of_scope) -contains 'src/payment/service.txt') 'Collect did not flag an out-of-scope change'
    $applyBlocked = Invoke-Orchestrate $ctx2 'Apply'
    Assert ($LASTEXITCODE -ne 0) 'Apply ran with an unresolved out_of_scope finding'
    Assert ($applyBlocked -match 'out_of_scope') 'Apply did not explain the out_of_scope block'
    # The coordinator's own status must NOT be auto-flipped: doing so would drop it out of
    # active_tasks and lock out the very orchestrate.ps1 actions needed to fix the situation
    # (widen ownership and re-collect, or -Action Reject). Whether to set status: blocked is the
    # user's call, recorded by hand in the Delivery log, not an automatic side effect of a Fail.
    $coord2 = Get-Content -LiteralPath (Join-Path $ctx2.CoordDir 'task.md') -Raw -Encoding UTF8
    Assert ($coord2 -match '(?m)^status: in_progress[ \t]*\r?$') 'Apply auto-changed the coordinator status on an out_of_scope finding'

    # A second Apply attempt must re-explain the same out_of_scope block, not silently proceed
    # or Fail on stale state - the coordinator is still expected to be able to retry.
    $applyBlockedAgain = Invoke-Orchestrate $ctx2 'Apply'
    Assert ($LASTEXITCODE -ne 0) 'a second Apply attempt did not re-block on the same out_of_scope finding'

    # -Action Reject: the user decides to discard the out-of-scope delivery instead of widening
    # ownership. This must actually unblock Apply on the remaining, in-scope delivery.
    $rejectOut = Invoke-Orchestrate $ctx2 'Reject' @{ WorkerId = $ids2[1] }
    Assert ($LASTEXITCODE -eq 0) "Reject failed: $rejectOut"
    $rejectedTask = Get-Content -LiteralPath (Join-Path $ctx2.State "projects\$($ctx2.ProjectId)\tasks\$($ids2[1])\task.md") -Raw -Encoding UTF8
    Assert ($rejectedTask -match '(?m)^delivery_status: rejected[ \t]*\r?$') 'Reject did not mark the delivery rejected'
    # Rejecting must not resurrect the out_of_scope Fail on a later Apply for this same worker.
    $applyAfterReject = Invoke-Orchestrate $ctx2 'Apply'
    Assert ($LASTEXITCODE -eq 0) "Apply failed after rejecting the out-of-scope delivery: $applyAfterReject"
    $otherTask = Get-Content -LiteralPath (Join-Path $ctx2.State "projects\$($ctx2.ProjectId)\tasks\$($ids2[0])\task.md") -Raw -Encoding UTF8
    Assert ($otherTask -match '(?m)^delivery_status: applied[ \t]*\r?$') 'the remaining in-scope delivery was not applied after the conflicting one was rejected'
    Assert ((Get-Content -LiteralPath (Join-Path $ctx2.CoordDir 'task.md') -Raw -Encoding UTF8) -match '(?m)^integration_status: applied[ \t]*\r?$') 'integration_status did not converge to applied after Reject + Apply'

    # Reject only accepts a currently-pending delivery.
    $doubleReject = Invoke-Orchestrate $ctx2 'Reject' @{ WorkerId = $ids2[1] }
    Assert ($LASTEXITCODE -ne 0) 'Reject accepted a delivery that was already rejected'

    # --- conflict then hand-merge (Resolve) ---
    #
    # Init's pairwise-disjoint check stops two workers claiming the same prefix through the front
    # door, so a same-path collision reaches Apply only via an ownership widening after the fact.
    # That is what is reproduced here: worker B's ownership is widened to cover a file worker A
    # already owns, which is exactly the adjudication orchestration.md prescribes.
    #
    # The colliding file is `src/payment/service.txt` - an EXISTING tracked file (status M for
    # both sides), not a newly added one. A bare Test-Path-only merge check would pass here
    # without either worker's edit ever landing (the file exists at base_commit too); this is the
    # shape that check must actually catch.

    $ctx3 = New-Lifecycle 'life3'
    Invoke-Orchestrate $ctx3 'Init' @{ PlanPath = (Get-DefaultPlan $ctx3) } | Out-Null
    $ids3 = @((Invoke-Json $resolver @{ Path = $ctx3.Repo; StateRoot = $ctx3.State; RosterFor = $ctx3.CoordId }).roster | ForEach-Object { $_.id })
    Complete-Worker $ctx3 $ids3[0] { param($wt) Write-Text (Join-Path $wt 'src\payment\service.txt') "payment from A`n" }
    Complete-Worker $ctx3 $ids3[1] { param($wt) Write-Text (Join-Path $wt 'src\report\service.txt') "report v2`n"; Write-Text (Join-Path $wt 'src\payment\service.txt') "payment from B`n" }
    # Widen worker B's ownership onto worker A's existing prefix, the documented adjudication for
    # an out_of_scope finding. Path-level ownership is now satisfied; the collision is not.
    $tf = Join-Path $ctx3.State "projects\$($ctx3.ProjectId)\tasks\$($ids3[1])\task.md"
    $tt = Get-Content -LiteralPath $tf -Raw -Encoding UTF8
    $tt = [regex]::Replace($tt, '(?m)^(file_ownership: \[)(.*)(\])[ \t]*\r?$', '$1$2, src/payment/service.txt$3')
    [IO.File]::WriteAllText($tf, $tt, $utf8NoBom)
    Invoke-Orchestrate $ctx3 'Collect' | Out-Null
    foreach ($id in $ids3) {
        $d = Get-Content -LiteralPath (Join-Path $ctx3.State "projects\$($ctx3.ProjectId)\tasks\$id\delivery.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert (@($d.ownership_findings.out_of_scope).Count -eq 0) "widening ownership did not clear out_of_scope for $id"
    }

    $apply3 = Invoke-Orchestrate $ctx3 'Apply'
    Assert ($apply3 -match 'conflict') "a same-path collision was not reported as a conflict: $apply3"
    Assert ($apply3 -match 'src/payment/service\.txt') 'the conflict did not name the colliding path'
    $coord3Path = Join-Path $ctx3.CoordDir 'task.md'
    Assert ((Get-Content -LiteralPath $coord3Path -Raw -Encoding UTF8) -match '(?m)^integration_status: conflicted[ \t]*\r?$') 'Apply did not move the coordinator to conflicted'

    # A conflicting delivery keeps its work: pending, never rejected.
    foreach ($id in $ids3) {
        $t = Get-Content -LiteralPath (Join-Path $ctx3.State "projects\$($ctx3.ProjectId)\tasks\$id\task.md") -Raw -Encoding UTF8
        Assert ($t -match '(?m)^delivery_status: pending[ \t]*\r?$') "conflicting worker $id was not left pending"
        Assert ($t -notmatch '(?m)^delivery_status: rejected[ \t]*\r?$') "conflicting worker $id was rejected instead of held for a hand merge"
    }
    $orch3 = Get-Content -LiteralPath (Join-Path $ctx3.CoordDir 'orchestration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($orch3.conflicts).Count -eq 2) "both sides of the collision should be recorded as conflicts, got $(@($orch3.conflicts).Count)"

    # Resolve must refuse while the merge has not actually been carried out - here, the file is
    # already present at base_commit, so plain existence proves nothing.
    $earlyResolve = Invoke-Orchestrate $ctx3 'Resolve' @{ WorkerId = $ids3[0] }
    Assert ($LASTEXITCODE -ne 0) 'Resolve accepted a delivery that was never merged into the main tree'
    Assert ($earlyResolve -match 'still not merged') 'Resolve did not explain what was missing'

    # A "merge" that leaves the file identical to base_commit is not a merge: report v2 alone
    # (worker B's other, non-conflicting change) is not enough to resolve the payment collision.
    Write-Text (Join-Path $ctx3.Repo 'src\report\service.txt') "report v2`n"
    $noopResolve = Invoke-Orchestrate $ctx3 'Resolve' @{ WorkerId = $ids3[0] }
    Assert ($LASTEXITCODE -ne 0) 'Resolve accepted a file that was still identical to base_commit'
    Assert ($noopResolve -match 'identical to base_commit') 'Resolve did not explain that the content had not actually changed'

    # Hand-merge exactly what the coordinator would write, then resolve both sides.
    Write-Text (Join-Path $ctx3.Repo 'src\payment\service.txt') "payment merged from A and B`n"
    foreach ($id in $ids3) {
        $resolveOut = Invoke-Orchestrate $ctx3 'Resolve' @{ WorkerId = $id }
        Assert ($LASTEXITCODE -eq 0) "Resolve failed for ${id}: $resolveOut"
        $t = Get-Content -LiteralPath (Join-Path $ctx3.State "projects\$($ctx3.ProjectId)\tasks\$id\task.md") -Raw -Encoding UTF8
        Assert ($t -match '(?m)^delivery_status: merged[ \t]*\r?$') "worker $id was not marked merged"
    }
    Assert ((Get-Content -LiteralPath $coord3Path -Raw -Encoding UTF8) -match '(?m)^integration_status: applied[ \t]*\r?$') 'resolving every conflict did not complete the integration'
    $orch3 = Get-Content -LiteralPath (Join-Path $ctx3.CoordDir 'orchestration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($orch3.conflicts).Count -eq 0) 'the conflict list was not emptied by Resolve'
    Assert (-not (& git -C $ctx3.Repo diff --cached --name-only)) 'the conflict flow staged changes into the index'

    # A merged delivery is as cleanable as an applied one.
    Invoke-Orchestrate $ctx3 'Cleanup' | Out-Null
    $wtRoot3 = Join-Path $ctx3.State "projects\$($ctx3.ProjectId)\worktrees"
    foreach ($id in $ids3) {
        Assert (-not (Test-Path -LiteralPath (Join-Path $wtRoot3 $id))) "Cleanup kept the worktree of merged worker $id"
    }

    # --- patch byte fidelity: delete, binary, and mixed CRLF/LF in one delivery ---
    #
    # New-Repo runs with core.autocrlf=false, so nothing here is line-ending-normalised by Git;
    # a round trip that silently touched bytes would show up as a mismatch below.

    $ctx4 = New-Lifecycle 'life4'
    Invoke-Orchestrate $ctx4 'Init' @{ PlanPath = (Get-DefaultPlan $ctx4) } | Out-Null
    $ids4 = @((Invoke-Json $resolver @{ Path = $ctx4.Repo; StateRoot = $ctx4.State; RosterFor = $ctx4.CoordId }).roster | ForEach-Object { $_.id })
    $binaryBytes = [byte[]](0x00, 0x01, 0x02, 0xFF, 0xFE, 0x00, 0x10, 0x7F, 0x80, 0x00)
    $mixedText = "line one`r`nline two`nline three`r`nno trailing newline"
    Complete-Worker $ctx4 $ids4[0] {
        param($wt)
        Remove-Item -LiteralPath (Join-Path $wt 'src\payment\service.txt') -Force       # delete an existing tracked file
        Write-Bytes (Join-Path $wt 'src\payment\logo.bin') $binaryBytes                 # add a binary file
        Write-Text (Join-Path $wt 'src\payment\mixed.txt') $mixedText                   # add mixed CRLF/LF, no final newline
    }
    Complete-Worker $ctx4 $ids4[1] { param($wt) Write-Text (Join-Path $wt 'src\report\service.txt') "report v2`n" }

    $collectOut4 = Invoke-Orchestrate $ctx4 'Collect'
    Assert ($LASTEXITCODE -eq 0) "Collect failed: $collectOut4"
    # Regression: PowerShell unwraps a single-element array to a scalar across a function return,
    # so a one-file delivery (worker B here touches only src/report/service.txt) previously made
    # $changed a bare object whose .Count was $null, printing "collected  path(s)" with a blank
    # instead of "1". @(New-DeliveryPatch ...) at the call site is what is being guarded here.
    Assert ($collectOut4 -match [regex]::Escape("$($ids4[1]): collected 1 path(s)")) "a single-file delivery's collected count printed blank instead of 1: $collectOut4"

    $delivery4 = Get-Content -LiteralPath (Join-Path $ctx4.State "projects\$($ctx4.ProjectId)\tasks\$($ids4[0])\delivery.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert (@($delivery4.changed_paths | Where-Object { $_.path -eq 'src/payment/service.txt' -and $_.status -eq 'D' }).Count -eq 1) 'the deleted file was not recorded with status D'
    Assert (@($delivery4.changed_paths | Where-Object { $_.path -eq 'src/payment/logo.bin' }).Count -eq 1) 'the added binary file was not recorded'
    Assert (@($delivery4.changed_paths | Where-Object { $_.path -eq 'src/payment/mixed.txt' }).Count -eq 1) 'the mixed-line-ending file was not recorded'

    Invoke-Orchestrate $ctx4 'Apply' | Out-Null
    Assert (-not (Test-Path -LiteralPath (Join-Path $ctx4.Repo 'src\payment\service.txt'))) 'Apply did not delete the file the worker removed'
    $appliedBinary = [IO.File]::ReadAllBytes((Join-Path $ctx4.Repo 'src\payment\logo.bin'))
    Assert ((Compare-Object $binaryBytes $appliedBinary -SyncWindow 0) -eq $null) 'the applied binary file does not match byte-for-byte'
    $appliedMixed = Get-Content -LiteralPath (Join-Path $ctx4.Repo 'src\payment\mixed.txt') -Raw -Encoding UTF8
    Assert ($appliedMixed -ceq $mixedText) 'the applied mixed CRLF/LF text does not match byte-for-byte (case-sensitive, exact)'

    Write-Output 'orchestrate tests passed'
} finally {
    & git -C (Join-Path $sandbox 'repo') worktree prune 2>&1 | Out-Null
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
