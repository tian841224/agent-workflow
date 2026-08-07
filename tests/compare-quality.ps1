[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$V3Results,
    [Parameter(Mandatory)][string]$V4Results
)

$ErrorActionPreference = 'Stop'
$cases = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'quality-cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$rank = @{ missing = 0; fail = 1; partial = 2; pass = 3 }
$issues = @()

foreach ($case in $cases.cases) {
    $v3Path = Join-Path $V3Results "$($case.id).json"
    $v4Path = Join-Path $V4Results "$($case.id).json"
    if (-not (Test-Path -LiteralPath $v3Path) -or -not (Test-Path -LiteralPath $v4Path)) {
        $issues += "missing result pair: $($case.id)"
        continue
    }
    $v3 = Get-Content -LiteralPath $v3Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $v4 = Get-Content -LiteralPath $v4Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($dimension in $case.required) {
        $old = [string]$v3.dimensions.$dimension
        $new = [string]$v4.dimensions.$dimension
        if (-not $rank.ContainsKey($old)) { $old = 'missing' }
        if (-not $rank.ContainsKey($new)) { $new = 'missing' }
        if ($rank[$new] -lt $rank[$old]) { $issues += "$($case.id)/$dimension regressed: $old -> $new" }
    }
}

if ($issues) { throw "v4 quality is below v3:`n$($issues -join "`n")" }
Write-Output 'v4 quality is not below the supplied v3 baseline.'
