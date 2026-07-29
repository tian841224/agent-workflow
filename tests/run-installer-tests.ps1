# Installer acceptance tests. Uses an isolated directory under the repository.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repo '.tmp-installer-tests'
if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Force $root | Out-Null
$claude = Join-Path $root 'claude'; $codex = Join-Path $root 'codex'; $antigravity = Join-Path $root 'gemini'; $canonical = Join-Path $root 'canonical'
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
    Assert (Test-Path (Join-Path $claude 'agents\architect.md')) 'Claude managed agent is installed without replacing other agents'
    Assert (Test-Path (Join-Path $codex 'skills\tdd\SKILL.md')) 'Codex managed skill is installed without replacing other skills'
    Get-Content (Join-Path $claude 'settings.json') -Raw | ConvertFrom-Json | Out-Null
    Get-Content (Join-Path $codex 'hooks.json') -Raw | ConvertFrom-Json | Out-Null
    Assert ((Get-Content (Join-Path $codex 'hooks.json') -Raw) -notmatch '\{\{HOOKS_DIR\}\}') 'Codex hook path is expanded'
    Run-Installer @('-TargetAgent','Antigravity','-AntigravityTarget',$antigravity,'-CanonicalTarget',$canonical)
    Assert (Test-Path (Join-Path $antigravity 'GEMINI.md')) 'Antigravity GEMINI.md is installed'
    Assert ((Get-Content (Join-Path $antigravity 'GEMINI.md') -Raw) -eq (Get-Content (Join-Path $canonical 'AGENTS.md') -Raw)) 'Antigravity uses canonical instructions'
    $antigravityHooks = Join-Path $antigravity 'config\hooks.json'
    Assert (Test-Path $antigravityHooks) 'Antigravity hooks.json is installed'
    Get-Content $antigravityHooks -Raw | ConvertFrom-Json | Out-Null
    Assert ((Get-Content $antigravityHooks -Raw) -notmatch '\{\{HOOKS_DIR\}\}') 'Antigravity hook path is expanded'
    Assert ((Get-Content $antigravityHooks -Raw) -match 'agent-workflow-git-guard') 'Antigravity git guard is registered'
    $globalWorkflowDir = Join-Path $antigravity 'config\global_workflows'
    Assert (Test-Path (Join-Path $globalWorkflowDir 'agent-workflow.md')) 'Antigravity current global workflow is installed'
    $agentWorkflow = Get-Content (Join-Path $globalWorkflowDir 'agent-workflow.md') -Raw
    Assert ($agentWorkflow -match '(?s)^---\s+description:\s+.+?\s+---') 'Antigravity workflow has description frontmatter'
    Assert ($agentWorkflow -eq (Get-Content (Join-Path $repo 'adapters\antigravity\workflows\agent-workflow.md') -Raw)) 'Antigravity current workflow uses native adapter content'
    $before = (Get-ChildItem $canonical -Recurse -File | Measure-Object).Count
    Run-Installer @('-TargetAgent','Both','-ClaudeTarget',$claude,'-CodexTarget',$codex,'-CanonicalTarget',$canonical)
    $after = (Get-ChildItem $canonical -Recurse -File | Measure-Object).Count
    Assert ($before -eq $after) 'second install keeps canonical file count stable'
    $dry = & (Join-Path $repo 'install.ps1') -DryRun -Agent Both -ClaudeTarget (Join-Path $root 'dry-claude') -CodexTarget (Join-Path $root 'dry-codex') -CanonicalTarget (Join-Path $root 'dry-canonical') | Out-String
    Assert (-not (Test-Path (Join-Path $root 'dry-canonical'))) 'DryRun does not create canonical directory'
    $statusOut = & (Join-Path $repo 'install.ps1') -Action Status -ClaudeTarget $claude -CodexTarget $codex -CanonicalTarget $canonical -AntigravityTarget $antigravity | Out-String
    Assert ($statusOut -match 'AntigravityExists\s*:\s*True') 'Status reports AntigravityExists'
    Assert ($statusOut -match 'AntigravityLinked\s*:\s*True') 'Status reports AntigravityLinked'
    $missingAntigravity = Join-Path $root 'no-such-gemini'
    $statusOut2 = & (Join-Path $repo 'install.ps1') -Action Status -ClaudeTarget $claude -CodexTarget $codex -CanonicalTarget $canonical -AntigravityTarget $missingAntigravity | Out-String
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "installer exit $LASTEXITCODE on missing antigravity target" }
    Assert ($statusOut2 -match 'AntigravityExists\s*:\s*False') 'Status handles missing Antigravity target without throwing'
    Write-Output '=== installer tests: PASS ==='
} finally {
    if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
