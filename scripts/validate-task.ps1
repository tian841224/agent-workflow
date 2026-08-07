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
foreach ($field in @('id','project_id','worktree_id')) {
    if ($data[$field] -and $data[$field] -notmatch $schema.properties.$field.pattern) { $errors += "invalid $field" }
}
if ($data.status -and @($schema.properties.status.enum) -notcontains $data.status) { $errors += 'invalid status' }

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

[pscustomobject]@{
    valid = ($errors.Count -eq 0)
    errors = @($errors)
    data = [pscustomobject]$data
    code_change = $codeChange
    risk_flags = $flags
} | ConvertTo-Json -Depth 8
