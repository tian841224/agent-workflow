$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$guard = Join-Path $root 'hooks\git-guard.ps1'
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-HookUtf8([string]$ScriptPath, [string]$Payload) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $hostExe
    $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $inputBytes = $utf8NoBom.GetBytes($Payload)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.BaseStream.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or $stderr) { throw "UTF-8 hook failed: exit=$($process.ExitCode) stderr=$stderr" }
    return $stdout
}

function Invoke-Guard([string]$Command) {
    $payload = @{ tool_input = @{ command = $Command } } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 $guard $payload
}
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

Assert ((Invoke-Guard 'git reset --hard HEAD') -match 'deny') 'destructive Git was not denied'
Assert ((Invoke-Guard 'git commit -m test') -match 'ask') 'Git write did not require approval'
Assert (-not (Invoke-Guard 'git status')) 'read-only Git should pass silently'

$quality = Get-Content -LiteralPath (Join-Path $root 'hooks\quality-gate.ps1') -Raw -Encoding UTF8
Assert ($quality -match 'active_tasks') 'quality gate does not resolve active tasks'
Assert ($quality -notmatch 'history\\tasks') 'quality gate must not scan history'

$qualityPath = Join-Path $root 'hooks\quality-gate.ps1'
$resolverPath = Join-Path $root 'scripts\project-resolver.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-hook-tests-' + [guid]::NewGuid().ToString('N'))
$utf8Text = -join @([char]0x4E2D,[char]0x6587)
$repo = Join-Path $sandbox ($utf8Text + '-repo')
$profile = Join-Path $sandbox 'profile'
$state = Join-Path $profile '.agent-workflow'
$oldProfile = $env:USERPROFILE

function Invoke-Quality([string]$Cwd) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); stop_hook_active = $false } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 $qualityPath $payload
}
function Invoke-ImpactGuard([string]$Cwd, [string]$FilePath) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); tool_name = 'Edit'; tool_input = @{ file_path = $FilePath } } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}
# Antigravity sends toolCall.args with PascalCase keys; TargetFile is not file_path.
function Invoke-ImpactGuardAntigravity([string]$Cwd, [string]$ToolName, [string]$FilePath) {
    $payload = @{ workspacePaths = @($Cwd); toolCall = @{ name = $ToolName; args = @{ TargetFile = $FilePath } } } | ConvertTo-Json -Compress -Depth 5
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}
# Codex apply_patch is a freeform tool: tool_input is patch text, paths live in the *** headers.
function Invoke-ImpactGuardCodex([string]$Cwd, [string]$Patch) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); tool_name = 'apply_patch'; tool_input = $Patch } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}
function Invoke-GuardAntigravity([string]$Command) {
    $payload = @{ toolCall = @{ name = 'run_command'; args = @{ CommandLine = $Command } } } | ConvertTo-Json -Compress -Depth 5
    return Invoke-HookUtf8 $guard $payload
}
function Invoke-QualityUtf8([string]$Cwd, [bool]$StopHookActive) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); stop_hook_active = $StopHookActive; last_assistant_message = $utf8Text } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 $qualityPath $payload
}
function Set-TestTask($Resolved, [string[]]$Flags, [string]$Extra = '', [bool]$CodeChange = $false, [switch]$Frozen) {
    Get-ChildItem -LiteralPath $Resolved.task_root -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    $taskDir = Join-Path $Resolved.task_root '20260807-000000-hook-test'
    New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
    $flagText = $Flags -join ', '
    $frozenAt = if ($Frozen) { '2026-08-07T00:00:00+08:00' } else { '' }
    $content = @"
---
id: 20260807-000000-hook-test
project_id: $($Resolved.project_id)
worktree_id: $($Resolved.worktree_id)
status: in_progress
code_change: $($CodeChange.ToString().ToLowerInvariant())
risk_flags: [$flagText]
created_at: 2026-08-07T00:00:00+08:00
updated_at: 2026-08-07T00:00:00+08:00
frozen_at: $frozenAt
---

## Goal
Goal text

## Scope
Scope text

## Completion criteria
- [x] complete

## Validation results
- pre-review: PASS
- command: test
- checks: pass
- skip reason: none
- limitations: none

$Extra
"@
    [IO.File]::WriteAllText((Join-Path $taskDir 'task.md'), $content, $utf8NoBom)
}

$impactSurface = @"
## Impact surface
- callers: rg RunExchange 3 hits, app/x.go:20
- entrypoints: HTTP POST /x
- shared state: none
- unverified: none
"@
$reviewResult = @"
$impactSurface

## Execution path and regression evidence
- path: A > B > C > D
- branches: error and retry
- evidence: full-path test

## Reviewer result
- result: PASS
- Architecture consistency: PASS
- Code quality and conventions: PASS
- Data consistency: N/A - no data change
- Security: N/A - no security change
- Risk and compatibility: PASS
- Performance: N/A - no hot path change
- Flow and impact completeness: PASS
"@
$verifierResult = "## Verifier result`n- PASS`n"
$roleResults = $reviewResult + "`n" + $verifierResult
$freezeSections = @"
## Non-goals and compatibility
None
## Current state and impact
Known
## Decision and tradeoffs
Selected
## Boundary and error paths
Covered
## User confirmation
Confirmed
"@

try {
    New-Item -ItemType Directory -Force -Path $repo,$profile | Out-Null
    & git -C $repo init --quiet
    [IO.File]::WriteAllText((Join-Path $repo 'fixture.txt'), 'fixture', $utf8NoBom)
    & git -C $repo add fixture.txt
    & git -C $repo -c user.name=agent-workflow -c user.email=agent-workflow@example.invalid commit --quiet -m fixture
    $env:USERPROFILE = $profile
    $resolved = (& $resolverPath -Path $repo -StateRoot $state -Ensure | Out-String) | ConvertFrom-Json

    Assert (-not (Invoke-QualityUtf8 $repo $true)) 'stop_hook_active with UTF-8 payload was not released silently'

    Set-TestTask $resolved @()
    Assert (-not (Invoke-Quality $repo)) 'basic task should require only the four base sections and pre-review evidence'
    $basicTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $basicContent = Get-Content -LiteralPath $basicTask.FullName -Raw -Encoding UTF8
    $basicContent = [regex]::Replace($basicContent, '(?ms)^## Goal.*?(?=^## Scope)', '')
    [IO.File]::WriteAllText($basicTask.FullName, $basicContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'Goal') 'basic task without Goal was accepted'
    $utf8Output = Invoke-QualityUtf8 $repo $false
    Assert (($utf8Output | ConvertFrom-Json).reason -match 'Goal') 'UTF-8 quality hook did not parse the Chinese workspace path or emit valid UTF-8 JSON'

    Set-TestTask $resolved @('behavior_change')
    Assert ((Invoke-Quality $repo) -match 'Acceptance cases') 'behavior_change did not require Acceptance cases'
    Set-TestTask $resolved @('behavior_change') "<!--`n## Acceptance cases`nA1`n-->`n"
    Assert ((Invoke-Quality $repo) -match 'Acceptance cases') 'commented Acceptance cases was treated as task content'
    Set-TestTask $resolved @('behavior_change') "## Acceptance cases`n| ID | Scenario | Expected | Verify |`n|---|---|---|---|`n| A1 | x | y | z |`n"
    $qualityOutput = Invoke-Quality $repo
    Assert (-not $qualityOutput) "valid non-code behavior_change task was blocked: $qualityOutput"

    Set-TestTask $resolved @('ui') "## Acceptance cases`nA1`n## Browser verification`nPASS`n"
    Assert (-not (Invoke-Quality $repo)) 'valid non-code ui task was blocked by a role gate'

    $contractBase = $freezeSections + "`n## Acceptance cases`nA1`n"
    Set-TestTask $resolved @('contract') $contractBase -Frozen
    Assert ((Invoke-Quality $repo) -match 'Contract and data impact') 'contract did not require Contract and data impact'
    Set-TestTask $resolved @('contract') ($contractBase + "## Contract and data impact`nNo schema change`n") -Frozen
    Assert (-not (Invoke-Quality $repo)) 'valid non-code contract task was blocked by a role gate'

    $crossFeature = $freezeSections + "`n## Acceptance cases`nA1`n"
    Set-TestTask $resolved @('cross_feature') $crossFeature -Frozen
    Assert ((Invoke-Quality $repo) -match 'Implementation sequence') 'cross_feature did not require Implementation sequence'
    Set-TestTask $resolved @('cross_feature') ($crossFeature + "## Implementation sequence`n1. change`n") -Frozen
    Assert (-not (Invoke-Quality $repo)) 'valid non-code cross_feature task was blocked by a role gate'

    Set-TestTask $resolved @('data_write')
    Assert ((Invoke-Quality $repo) -match 'Contract and data impact') 'data_write did not require Contract and data impact'

    Set-TestTask $resolved @() '' $true
    $codeGateOutput = Invoke-Quality $repo
    Assert ($codeGateOutput -match 'Impact surface') 'code_change task did not require impact surface'
    Assert ($codeGateOutput -match 'Execution path and regression evidence') 'code_change task did not require execution path evidence'
    Assert ($codeGateOutput -match 'Reviewer result') 'code_change task did not require Reviewer'
    Assert ($codeGateOutput -match 'Verifier result') 'code_change task did not require Verifier'
    Set-TestTask $resolved @() ("## Reviewer result`npending`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result is missing or not passed') 'pending Reviewer result was accepted'
    $reviewWithoutPass = $reviewResult -replace '(?m)^- result: PASS\r?\n', ''
    Set-TestTask $resolved @() ($reviewWithoutPass + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result is missing or not passed') 'Reviewer result without explicit PASS was accepted'
    $reviewMalformedPass = $reviewResult -replace '(?m)^- result: PASS$', "-`nresult:`nPASS"
    Set-TestTask $resolved @() ($reviewMalformedPass + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result is missing or not passed') 'multiline Reviewer PASS was accepted'
    $reviewCheckedDimensions = $reviewResult -replace '(?m)^- Architecture consistency: PASS$', '- Architecture consistency: checked'
    Set-TestTask $resolved @() ($reviewCheckedDimensions + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Architecture consistency') 'Reviewer dimension without PASS was accepted'
    $reviewWithHistory = $reviewResult -replace '(?m)^- Risk and compatibility: PASS$', '- Risk and compatibility: PASS - previous FAIL was resolved'
    Set-TestTask $resolved @() ($reviewWithHistory + "`n" + $verifierResult) $true
    Assert (-not (Invoke-Quality $repo)) 'Reviewer PASS explanation mentioning a previous FAIL was rejected'
    $reviewAmbiguousPass = $reviewResult -replace '(?m)^- Architecture consistency: PASS$', '- Architecture consistency: PASS/FAIL'
    Set-TestTask $resolved @() ($reviewAmbiguousPass + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Architecture consistency') 'ambiguous PASS/FAIL Reviewer dimension was accepted'
    $reviewAmbiguousNA = $reviewResult -replace '(?m)^- Data consistency: N/A - no data change$', '- Data consistency: N/A/FAIL'
    Set-TestTask $resolved @() ($reviewAmbiguousNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Data consistency') 'ambiguous N/A/FAIL Reviewer dimension was accepted'
    $reviewFlowNA = $reviewResult -replace '(?m)^- Flow and impact completeness: PASS$', '- Flow and impact completeness: N/A'
    Set-TestTask $resolved @() ($reviewFlowNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Flow and impact completeness') 'flow and impact completeness accepted N/A'
    Set-TestTask $resolved @() ($reviewResult + "`n## Verifier result`n- FAIL`n") $true
    Assert ((Invoke-Quality $repo) -match 'Verifier result is missing or not passed') 'failed Verifier result was accepted'
    Set-TestTask $resolved @() $roleResults $true
    Assert (-not (Invoke-Quality $repo)) 'valid code_change task was blocked'

    Set-TestTask $resolved @() ($reviewResult + "`n" + $verifierResult) $true
    $pathTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $pathContent = Get-Content -LiteralPath $pathTask.FullName -Raw -Encoding UTF8
    $pathContent = $pathContent -replace '(?ms)^## Execution path and regression evidence.*?(?=^## Reviewer result)', ''
    [IO.File]::WriteAllText($pathTask.FullName, $pathContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'Execution path and regression evidence') 'missing execution path evidence was accepted'

    Set-TestTask $resolved @() ($reviewResult + "`n" + $verifierResult) $true
    $impactTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $impactContent = Get-Content -LiteralPath $impactTask.FullName -Raw -Encoding UTF8
    $impactContent = $impactContent -replace '(?ms)^## Impact surface.*?(?=^## Execution path)', ''
    [IO.File]::WriteAllText($impactTask.FullName, $impactContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'Impact surface') 'missing impact surface was accepted'

    # impact-guard: the ordering gate that quality-gate structurally cannot enforce.
    $codeFile = Join-Path $repo 'app\x.go'
    Get-ChildItem -LiteralPath $resolved.task_root -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'impact-guard blocked an edit with no active task'
    Set-TestTask $resolved @()
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'impact-guard blocked a code_change: false task'
    Set-TestTask $resolved @() '' $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'Impact surface') 'impact-guard allowed a code edit before the impact surface was filled'
    $guardTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    Assert (-not (Invoke-ImpactGuard $repo $guardTask.FullName)) 'impact-guard deadlocked the task file it demands be edited'
    Assert (-not (Invoke-ImpactGuard $repo (Join-Path $sandbox 'outside.go'))) 'impact-guard blocked a file outside the workspace'
    Set-TestTask $resolved @() ("## Impact surface`n- callers: <search command and hit count>`n") $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'Impact surface') 'impact-guard accepted an untouched placeholder template'
    Set-TestTask $resolved @() $impactSurface $true
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'impact-guard blocked an edit after the impact surface was filled'

    # Antigravity: args use PascalCase TargetFile, so file_path-style lookups silently miss.
    Set-TestTask $resolved @() '' $true
    foreach ($agTool in @('write_to_file','replace_file_content','multi_replace_file_content')) {
        Assert ((Invoke-ImpactGuardAntigravity $repo $agTool $codeFile) -match 'Impact surface') "impact-guard ignored Antigravity $agTool"
    }
    $agGuardTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    Assert (-not (Invoke-ImpactGuardAntigravity $repo 'write_to_file' $agGuardTask.FullName)) 'impact-guard deadlocked the Antigravity task file'
    Set-TestTask $resolved @() $impactSurface $true
    Assert (-not (Invoke-ImpactGuardAntigravity $repo 'write_to_file' $codeFile)) 'impact-guard blocked Antigravity after the impact surface was filled'

    # Codex: apply_patch carries paths in patch headers, not in a file_path argument.
    Set-TestTask $resolved @() '' $true
    $codexPatch = "*** Begin Patch`n*** Update File: app/x.go`n@@`n-old`n+new`n*** End Patch"
    Assert ((Invoke-ImpactGuardCodex $repo $codexPatch) -match 'Impact surface') 'impact-guard ignored a Codex apply_patch edit'
    $addPatch = "*** Begin Patch`n*** Add File: app/new.go`n+package app`n*** End Patch"
    Assert ((Invoke-ImpactGuardCodex $repo $addPatch) -match 'Impact surface') 'impact-guard ignored a Codex apply_patch add'
    $outsidePatch = "*** Begin Patch`n*** Update File: " + (Join-Path $sandbox 'outside.go').Replace('\','/') + "`n+x`n*** End Patch"
    Assert (-not (Invoke-ImpactGuardCodex $repo $outsidePatch)) 'impact-guard blocked a Codex patch outside the workspace'
    Set-TestTask $resolved @() $impactSurface $true
    Assert (-not (Invoke-ImpactGuardCodex $repo $codexPatch)) 'impact-guard blocked Codex after the impact surface was filled'

    # git-guard reads Antigravity commands from args.CommandLine, not args.command.
    Assert ((Invoke-GuardAntigravity 'git reset --hard HEAD') -match 'deny') 'git-guard ignored a destructive Antigravity command'
    Assert ((Invoke-GuardAntigravity 'git commit -m test') -match 'ask') 'git-guard ignored an Antigravity Git write'
    Assert (-not (Invoke-GuardAntigravity 'git status')) 'git-guard blocked a read-only Antigravity command'

    Set-TestTask $resolved @()
    $taskPath = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $taskContent = Get-Content -LiteralPath $taskPath.FullName -Raw -Encoding UTF8
    $taskContent = $taskContent -replace '(?m)^code_change: false$', 'code_change: maybe'
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'code_change must be true or false') 'invalid code_change was accepted'
    $taskContent = $taskContent -replace '(?m)^code_change: maybe\r?\n', ''
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'missing required field: code_change') 'missing code_change was accepted'

    Set-TestTask $resolved @() ''
    $taskPath = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $taskContent = Get-Content -LiteralPath $taskPath.FullName -Raw -Encoding UTF8
    $taskContent = $taskContent -replace '(?m)^- pre-review: PASS$', '- pre-review: SKIP' -replace '(?m)^- skip reason: none$', '- skip reason: <reason>'
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'SKIP pre-review requires a reason') 'SKIP without a reason was accepted'
} finally {
    $env:USERPROFILE = $oldProfile
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
Write-Output 'hook tests passed'
