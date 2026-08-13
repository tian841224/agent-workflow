[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CoordinatorTaskPath,
    [Parameter(Mandatory)][string]$PlanPath,
    [int]$MinimumEstimatedUnits = 2
)

# Split eligibility gate. orchestration.md states the conditions in prose; this script is what
# actually enforces them, so a split can never be started on nothing more than an assertion in
# the conversation. It creates nothing and changes nothing - Init calls it first and refuses to
# build any worktree unless `eligible` comes back true.

$ErrorActionPreference = 'Stop'
$errors = @()
$workers = @()

function Read-Frontmatter([string]$Path) {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $match = [regex]::Match($text, '(?ms)^---\r?\n(.*?)\r?\n---')
    if (-not $match.Success) { throw "missing frontmatter: $Path" }
    $data = @{}
    foreach ($line in ($match.Groups[1].Value -split '\r?\n')) {
        if ($line -match '^([a-z_]+):[ \t]*(.*)$') { $data[$Matches[1]] = $Matches[2].Trim() }
    }
    return $data
}

# Must stay identical to the grammar in validate-task.ps1: anything this script accepts is
# written straight into a worker task's file_ownership, and would fail validation there.
function Test-OwnershipEntry([string]$Entry) {
    if (-not $Entry) { return 'must not be empty' }
    if ($Entry -match '^([a-zA-Z]:|/|\\)') { return 'must be repo-relative' }
    if ($Entry -match '\\') { return 'must use / as the separator' }
    if ($Entry -like './*') { return 'must not start with ./' }
    if ($Entry -match '(^|/)\.\.(/|$)') { return 'must not contain ..' }
    if ($Entry -match '[\[\],]') { return 'must not contain , [ or ]' }
    return ''
}

function Test-PrefixOverlap([string]$Left, [string]$Right) {
    if ($Left.Equals($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Left.EndsWith('/') -and $Right.StartsWith($Left, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Right.EndsWith('/') -and $Left.StartsWith($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

# Shared registration points: two workers editing the same route table, schema, DI container,
# barrel index or lockfile produce changes that are textually disjoint per worker yet still
# conflict in meaning. These stay sequential regardless of how the paths are drawn.
$serialSegments = @(
    'schema', 'schemas', 'contract', 'contracts', 'route', 'routes', 'router',
    'di', 'barrel', 'i18n', 'locale', 'locales', 'migrations'
)
$serialFiles = @(
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'cargo.lock',
    'composer.lock', 'gemfile.lock', 'poetry.lock',
    'index.ts', 'index.js', 'index.tsx', 'index.jsx', 'mod.rs'
)

# V5's version only inspected the last path segment, so `src/api/routes.ts` slipped through:
# the segment is "routes.ts", not "routes". Every segment is checked, with its extension
# stripped, and whole filenames are matched separately for lockfiles and barrel indexes.
function Get-SerialSurfaceHit([string]$Path) {
    foreach ($segment in @($Path -split '/' | Where-Object { $_ })) {
        $lower = $segment.ToLowerInvariant()
        if ($serialFiles -contains $lower) { return $segment }
        $stem = [IO.Path]::GetFileNameWithoutExtension($lower)
        if ($stem -and $serialSegments -contains $stem) { return $segment }
    }
    return ''
}

try {
    if (-not (Test-Path -LiteralPath $CoordinatorTaskPath -PathType Leaf)) { throw "coordinator task not found: $CoordinatorTaskPath" }
    if (-not (Test-Path -LiteralPath $PlanPath -PathType Leaf)) { throw "split plan not found: $PlanPath" }

    $task = Read-Frontmatter $CoordinatorTaskPath
    if ($task.subtask_role -ne 'coordinator') { $errors += 'task must declare subtask_role: coordinator' }
    if (-not $task.frozen_at) { $errors += 'coordinator task must be frozen before splitting' }

    # A malformed plan is a hard stop: the checks below all read fields off it, and reporting
    # "0 workers" for an unparseable file would be actively misleading.
    $plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $plan.user_confirmed) { $errors += 'split plan requires user_confirmed: true' }
    if ($plan.shared_persistent_state) { $errors += 'split plan declares shared persistent state' }
    if ($plan.has_order_dependency) { $errors += 'split plan declares an ordering dependency' }

    $workers = @($plan.workers)
    if ($workers.Count -lt 2) { $errors += 'split plan requires at least two workers; a single feature stays a normal task' }

    $seenIds = @{}
    $owned = @()
    foreach ($worker in $workers) {
        $workerId = [string]$worker.id
        # -cnotmatch, not -notmatch: PowerShell's default is case-insensitive, and the id becomes
        # both a worktree directory name and the slug half of a task id, which validate-task.ps1
        # requires to be lowercase.
        if (-not $workerId -or $workerId -cnotmatch '^[a-z0-9-]+$') { $errors += "worker id must use lowercase letters, digits and hyphens: '$workerId'"; continue }
        if ($seenIds.ContainsKey($workerId)) { $errors += "worker id is duplicated: $workerId"; continue }
        $seenIds[$workerId] = $true
        if (-not $worker.title) { $errors += "worker $workerId has no title" }
        if ([int]$worker.estimated_units -lt $MinimumEstimatedUnits) { $errors += "worker $workerId is below the minimum split size ($MinimumEstimatedUnits)" }

        $paths = @($worker.file_ownership)
        if ($paths.Count -eq 0) { $errors += "worker $workerId declares no file_ownership"; continue }
        foreach ($raw in $paths) {
            $path = [string]$raw
            $reason = Test-OwnershipEntry $path
            if ($reason) { $errors += "worker ${workerId} ownership '$path': $reason"; continue }
            $hit = Get-SerialSurfaceHit $path
            if ($hit) { $errors += "worker $workerId owns a default-serial surface ('$hit' in '$path'); keep this sequential" }
            foreach ($prior in $owned) {
                if (Test-PrefixOverlap $path $prior.path) {
                    $errors += "ownership overlaps: '$path' ($workerId) and '$($prior.path)' ($($prior.worker))"
                }
            }
            $owned += [pscustomobject]@{ worker = $workerId; path = $path }
        }
    }
} catch {
    $errors += $_.Exception.Message
}

[pscustomobject]@{
    eligible = ($errors.Count -eq 0)
    errors = @($errors)
    workers = @($workers)
} | ConvertTo-Json -Depth 8
exit 0
