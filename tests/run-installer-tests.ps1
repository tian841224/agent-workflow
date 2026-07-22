# Installer acceptance tests. Uses an isolated directory under the repository.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repo '.tmp-installer-tests'
if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Force $root | Out-Null
$claude = Join-Path $root 'claude'; $codex = Join-Path $root 'codex'; $canonical = Join-Path $root 'canonical'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; Write-Output "[PASS] $Message" }
function Run-Installer([string[]]$InstallerArgs) {
    $named = @{}
    for ($i=0; $i -lt $InstallerArgs.Count; $i+=2) { $named[$InstallerArgs[$i].TrimStart('-')] = $InstallerArgs[$i+1] }
    & (Join-Path $repo 'install.ps1') @named
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "installer exit $LASTEXITCODE" }
}
try {
    Run-Installer @('-TargetAgent','Both','-ClaudeTarget',$claude,'-CodexTarget',$codex,'-CanonicalTarget',$canonical)
    Assert (Test-Path (Join-Path $canonical 'workflow\WORKFLOW.md')) 'canonical shared workflow is installed once'
    Assert ((Get-Item (Join-Path $claude 'agents')).LinkType -eq 'Junction') 'Claude agents points to canonical core'
    Assert ((Get-Item (Join-Path $codex 'skills')).LinkType -eq 'Junction') 'Codex skills points to canonical core'
    Get-Content (Join-Path $claude 'settings.json') -Raw | ConvertFrom-Json | Out-Null
    Get-Content (Join-Path $codex 'hooks.json') -Raw | ConvertFrom-Json | Out-Null
    Assert ((Get-Content (Join-Path $codex 'hooks.json') -Raw) -notmatch '\{\{HOOKS_DIR\}\}') 'Codex hook path is expanded'
    $before = (Get-ChildItem $canonical -Recurse -File | Measure-Object).Count
    Run-Installer @('-TargetAgent','Both','-ClaudeTarget',$claude,'-CodexTarget',$codex,'-CanonicalTarget',$canonical)
    $after = (Get-ChildItem $canonical -Recurse -File | Measure-Object).Count
    Assert ($before -eq $after) 'second install keeps canonical file count stable'
    $dry = & (Join-Path $repo 'install.ps1') -DryRun -Agent Both -ClaudeTarget (Join-Path $root 'dry-claude') -CodexTarget (Join-Path $root 'dry-codex') -CanonicalTarget (Join-Path $root 'dry-canonical') | Out-String
    Assert (-not (Test-Path (Join-Path $root 'dry-canonical'))) 'DryRun does not create canonical directory'
    Run-Installer @('-Action','Status','-ClaudeTarget',$claude,'-CodexTarget',$codex,'-CanonicalTarget',$canonical)
    Write-Output '=== installer tests: PASS ==='
} finally {
    if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
