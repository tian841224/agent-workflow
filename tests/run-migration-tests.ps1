$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-migration-' + [guid]::NewGuid().ToString('N'))
$claude = Join-Path $sandbox '.claude'
$codex = Join-Path $sandbox '.codex'
$state = Join-Path $sandbox '.agent-workflow'
$repos = Join-Path $sandbox 'repos'

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $claude 'memory') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $codex 'memories\cache') | Out-Null
    New-Item -ItemType Directory -Force -Path $repos | Out-Null
    Set-Content -LiteralPath (Join-Path $claude 'memory\one.md') -Value '# one' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $claude 'memory\duplicate.md') -Value '# one' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $codex 'memories\cache\tool.txt') -Value 'excluded' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $repos 'DECISIONS.md') -Value '# unresolved' -Encoding UTF8

    $script = Join-Path $root 'migrate-v3.ps1'
    & $script -Action Inventory -StateRoot $state -ClaudeRoot $claude -CodexRoot $codex -RepoSearchRoot $repos
    & $script -Action Stage -StateRoot $state -ClaudeRoot $claude -CodexRoot $codex -RepoSearchRoot $repos
    & $script -Action Validate -StateRoot $state -ClaudeRoot $claude -CodexRoot $codex -RepoSearchRoot $repos
    $run = Get-ChildItem -LiteralPath (Join-Path $state 'imports') -Directory | Select-Object -First 1
    $report = Get-Content -LiteralPath (Join-Path $run.FullName 'validation-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $report.success) { throw 'migration validation did not succeed' }
    & $script -Action Activate -StateRoot $state -ClaudeRoot $claude -CodexRoot $codex -RepoSearchRoot $repos -AcceptUnresolvedManifestHash $report.manifest_hash
    if (-not (Test-Path -LiteralPath (Join-Path $state 'activation.json'))) { throw 'activation marker missing' }
    if (-not (Get-ChildItem -LiteralPath (Join-Path $state 'knowledge\global\entries') -File -ErrorAction SilentlyContinue)) { throw 'global knowledge was not activated' }
    Write-Output 'migration tests passed'
} finally {
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
