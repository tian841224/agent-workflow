# agent-workflow v4 - runs this repo's own test suite as part of pre-review.
#
# pre-review.ps1's built-in checks only fire for go.mod/package.json repos; this repo has
# neither, so it always reported RESULT: SKIP and none of tests/run-*.ps1 was ever executed as
# part of a review or completion gate for changes to this framework's own hooks, scripts, and
# schemas - the same "configured but never runs" failure mode this framework's own README
# criticizes elsewhere. pre-review.ps1 already has an extension point for exactly this
# (`Invoke-Check 'pre-review-extra'` when this file exists next to it); this file is that
# extension, not a change to pre-review.ps1 itself.
#
# Each runner is spawned as its own subprocess (matching how the runners themselves already
# spawn subprocesses to test hooks and CLI scripts), so a runner that leaves $env:PATH or a
# working directory modified cannot bleed into the next one. Output is passed straight through;
# pre-review.ps1's own Invoke-Check only checks the exit code, so a partial run still shows
# which runners had already passed before a later one failed.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
$failures = @()

$runners = @(Get-ChildItem -LiteralPath (Join-Path $root 'tests') -Filter 'run-*.ps1' -File -ErrorAction SilentlyContinue | Sort-Object Name)
if ($runners.Count -eq 0) {
    Write-Output 'no tests/run-*.ps1 runners found'
    exit 0
}

foreach ($runner in $runners) {
    Write-Output "--- $($runner.Name) ---"
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $hostExe -NoProfile -ExecutionPolicy Bypass -File $runner.FullName 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    $output | ForEach-Object { Write-Output ([string]$_) }
    if ($exitCode -ne 0) { $failures += $runner.Name }
}

if ($failures.Count -gt 0) {
    Write-Output "FAILED runners: $($failures -join ', ')"
    exit 1
}
Write-Output "all $($runners.Count) test runners passed"
exit 0
