[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskPath,
    [string]$SchemaPath = (Join-Path $PSScriptRoot '..\schemas\task.schema.json')
)

$ErrorActionPreference = 'Stop'
$errors = @()
$content = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
$schema = Get-Content -LiteralPath $SchemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
$match = [regex]::Match($content, '(?ms)^---\r?\n(.*?)\r?\n---')
if (-not $match.Success) {
    [pscustomobject]@{ valid=$false; errors=@('missing YAML frontmatter'); data=@{} } | ConvertTo-Json -Depth 8
    exit 0
}

$data = @{}
foreach ($line in ($match.Groups[1].Value -split '\r?\n')) {
    if ($line -match '^([a-z_]+):[ \t]*(.*)$') { $data[$Matches[1]] = $Matches[2].Trim() }
}

foreach ($field in $schema.required) {
    if (-not $data.ContainsKey($field) -or -not $data[$field]) { $errors += "missing required field: $field" }
}
# additionalProperties: false is only meaningful if something enforces it. Without this, a
# mistyped key (subtask_rol, delivery_stauts) reads as "field absent" and every conditional
# rule below silently skips instead of failing.
foreach ($field in $data.Keys) {
    if (@($schema.properties.PSObject.Properties.Name) -notcontains $field) { $errors += "unknown field: $field" }
}
foreach ($field in @('id','project_id','worktree_id')) {
    if ($data[$field] -and $data[$field] -notmatch $schema.properties.$field.pattern) { $errors += "invalid $field" }
}
if ($data.status -and @($schema.properties.status.enum) -notcontains $data.status) { $errors += 'invalid status' }
# change_kind stays out of schema.required: the existing task corpus and the worker frontmatter
# orchestrate.ps1 writes have no such field, and invalidating them would break every gate that
# runs the validator first. task-gate.ps1 is what requires it on a code change.
if ($data.change_kind -and @($schema.properties.change_kind.enum) -notcontains $data.change_kind) { $errors += "invalid change_kind: $($data.change_kind)" }

$codeChange = $null
if ($data.code_change -eq 'true') {
    $codeChange = $true
} elseif ($data.code_change -eq 'false') {
    $codeChange = $false
} elseif ($data.ContainsKey('code_change')) {
    $errors += 'code_change must be true or false'
}

$flags = @()
if ($data.risk_flags -match '^\[(.*)\]$') {
    $flags = @($Matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
} else { $errors += 'risk_flags must use inline array syntax' }
$allowedFlags = @($schema.properties.risk_flags.items.enum)
foreach ($flag in $flags) { if ($allowedFlags -notcontains $flag) { $errors += "invalid risk flag: $flag" } }
if (@($flags | Sort-Object -Unique).Count -ne $flags.Count) { $errors += 'risk_flags contains duplicates' }

foreach ($field in @('created_at','updated_at')) {
    $parsed = [DateTimeOffset]::MinValue
    if ($data[$field] -and -not [DateTimeOffset]::TryParse($data[$field], [ref]$parsed)) { $errors += "invalid date-time: $field" }
}
if ($data.frozen_at) {
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($data.frozen_at, [ref]$parsed)) { $errors += 'invalid date-time: frozen_at' }
}

# --- coordinator/worker orchestration fields ---
# The schema keeps these optional so existing tasks stay valid; once subtask_role is present
# the role-specific fields become mandatory and role-scoped.

$subtaskRole = $data.subtask_role
if ($subtaskRole -and @($schema.properties.subtask_role.enum) -notcontains $subtaskRole) {
    $errors += "invalid subtask_role: $subtaskRole"
    $subtaskRole = ''
}

$ownership = @()
if ($data.ContainsKey('file_ownership')) {
    if ($data.file_ownership -match '^\[(.*)\]$') {
        $ownership = @($Matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($ownership.Count -eq 0) { $errors += 'file_ownership must not be empty' }
    } else {
        # A block array parses as an empty scalar here, so it must fail loudly rather than read as unset.
        $errors += 'file_ownership must use inline array syntax'
    }
    foreach ($entry in $ownership) {
        $reason = ''
        if ($entry -match '^([a-zA-Z]:|/|\\)') { $reason = 'must be repo-relative' }
        elseif ($entry -match '\\') { $reason = 'must use / as the separator' }
        elseif ($entry -like './*') { $reason = 'must not start with ./' }
        elseif ($entry -match '(^|/)\.\.(/|$)') { $reason = 'must not contain ..' }
        elseif ($entry -match '[\[\]]') { $reason = 'must not contain [ or ]' }
        if ($reason) { $errors += "invalid file_ownership entry '$entry': $reason" }
    }
    if (@($ownership | Sort-Object -Unique).Count -ne $ownership.Count) { $errors += 'file_ownership contains duplicates' }
}

foreach ($field in @('delivery_status','integration_status')) {
    if ($data[$field] -and @($schema.properties.$field.enum) -notcontains $data[$field]) { $errors += "invalid ${field}: $($data[$field])" }
}
if ($data.parent_task_id -and $data.parent_task_id -notmatch $schema.properties.parent_task_id.pattern) { $errors += 'invalid parent_task_id' }
# base_commit is also the Reviewer's diff base (`git diff <base_commit>`), so an abbreviated or
# non-hex value is not merely cosmetic: it would silently review against the wrong tree.
if ($data.base_commit -and $data.base_commit -notmatch $schema.properties.base_commit.pattern) { $errors += 'invalid base_commit' }

$workerFields = @('parent_task_id','base_commit','file_ownership','delivery_status')
$coordinatorFields = @('integration_status')
if ($subtaskRole -eq 'worker') {
    foreach ($field in $workerFields) {
        if (-not $data.ContainsKey($field) -or -not $data[$field]) { $errors += "worker task requires $field" }
    }
    foreach ($field in $coordinatorFields) {
        if ($data.ContainsKey($field)) { $errors += "worker task must not set $field" }
    }
    # A worker that flips code_change would skip Reviewer and Verifier entirely.
    if ($codeChange -ne $true) { $errors += 'worker task requires code_change: true' }
} elseif ($subtaskRole -eq 'coordinator') {
    foreach ($field in $coordinatorFields) {
        if (-not $data.ContainsKey($field) -or -not $data[$field]) { $errors += "coordinator task requires $field" }
    }
    foreach ($field in $workerFields) {
        if ($data.ContainsKey($field)) { $errors += "coordinator task must not set $field" }
    }
    if ($codeChange -ne $true) { $errors += 'coordinator task requires code_change: true' }
} else {
    foreach ($field in ($workerFields + $coordinatorFields)) {
        if ($data.ContainsKey($field)) { $errors += "$field requires subtask_role" }
    }
}

[pscustomobject]@{
    valid = ($errors.Count -eq 0)
    errors = @($errors)
    data = [pscustomobject]$data
    code_change = $codeChange
    change_kind = $data.change_kind
    risk_flags = $flags
    subtask_role = $subtaskRole
    file_ownership = $ownership
} | ConvertTo-Json -Depth 8
