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
# The status: done gate reads what is about to be written, so these variants carry content as
# well as a path - one per platform payload shape.
function Invoke-ImpactGuardWrite([string]$Cwd, [string]$FilePath, [string]$Content) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); tool_name = 'Write'; tool_input = @{ file_path = $FilePath; content = $Content } } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}
function Invoke-ImpactGuardEdit([string]$Cwd, [string]$FilePath, [string]$NewString) {
    $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); tool_name = 'Edit'; tool_input = @{ file_path = $FilePath; new_string = $NewString } } | ConvertTo-Json -Compress
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}
function Invoke-ImpactGuardAntigravityEdit([string]$Cwd, [string]$FilePath, [string]$CodeEdit) {
    $payload = @{ workspacePaths = @($Cwd); toolCall = @{ name = 'replace_file_content'; args = @{ TargetFile = $FilePath; CodeEdit = $CodeEdit } } } | ConvertTo-Json -Compress -Depth 5
    return Invoke-HookUtf8 (Join-Path $root 'hooks\impact-guard.ps1') $payload
}

# close-task.ps1 is a plain script, not a hook: it is judged by its exit code and whether it
# leaves the task file alone when it refuses.
function Invoke-CloseTask([string]$Cwd) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $hostExe
    $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'scripts\close-task.ps1')`" -Path `"$Cwd`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    $startInfo.EnvironmentVariables['USERPROFILE'] = $env:USERPROFILE
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Text = ($stdout + $stderr) }
}

# Generic subprocess runner for scripts (like waive-roles.ps1) that take their own named
# parameters rather than a stdin JSON payload - the hook helpers above all assume the latter.
# ProcessStartInfo.ArgumentList is not reliably present on PS 5.1, so this uses the call operator
# instead, same as run-orchestrate-tests.ps1's own Invoke-Native. 2>&1 on a native command wraps
# stderr lines as ErrorRecords under this script's ErrorActionPreference = 'Stop', which would
# abort the whole run instead of just failing one assertion, so the preference is relaxed only
# around the call.
function Invoke-Native([string]$Exe, [string[]]$NativeArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @NativeArgs 2>&1
        return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($output | Out-String) }
    } finally { $ErrorActionPreference = $previous }
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
function Set-TestTask($Resolved, [string[]]$Flags, [string]$Extra = '', [bool]$CodeChange = $false, [string]$ChangeKind = '', [switch]$Frozen) {
    Get-ChildItem -LiteralPath $Resolved.task_root -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    $taskDir = Join-Path $Resolved.task_root '20260807-000000-hook-test'
    New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
    $flagText = $Flags -join ', '
    $frozenAt = if ($Frozen) { '2026-08-07T00:00:00+08:00' } else { '' }
    # Omitted entirely when empty: an unset change_kind is the pre-retrospective task shape, and
    # the gate has to keep treating a blank line as "absent" rather than as a valid value.
    $changeKindLine = if ($ChangeKind) { "`nchange_kind: $ChangeKind" } else { '' }
    $content = @"
---
id: 20260807-000000-hook-test
project_id: $($Resolved.project_id)
worktree_id: $($Resolved.worktree_id)
status: in_progress
code_change: $($CodeChange.ToString().ToLowerInvariant())$changeKindLine
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
- diff_sha256: $script:fingerprint
- mutation check: PASS

$Extra
"@
    [IO.File]::WriteAllText((Join-Path $taskDir 'task.md'), $content, $utf8NoBom)
}

# Bundled with Impact surface on purpose: every existing fixture that represents "this
# code_change task is in a valid, editable state" builds on $impactSurface, and the Project docs
# read: gate sits in the exact same guard (impact-guard.ps1) and the exact same task-gate.ps1
# $needsReviewer block, one check earlier. Keeping them in one fixture is what lets the rest of
# this file's existing assertions stay correct without touching every call site by hand.
$projectDocsSection = @"
## Project docs
- read: none - test fixture, project has no docs yet
- updated: none - test fixture, no structural change
"@
$impactSurface = @"
$projectDocsSection

## Impact surface
- callers: rg RunExchange 3 hits, app/x.go:20
- entrypoints: HTTP POST /x
- shared state: none
- unverified: none
"@
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

    # A role verdict is only valid against the diff it read, so the gate recomputes the working
    # tree fingerprint and compares. The fixtures therefore have to carry this sandbox's real
    # value - a hard-coded one would make every positive case pass for the wrong reason. Nothing
    # below writes into $repo, so the fingerprint stays valid for the whole run.
    $fingerprint = ((& (Join-Path $root 'scripts\worktree-fingerprint.ps1') -Path $repo | Out-String) | ConvertFrom-Json).sha256
    Assert ($fingerprint -match '^[0-9a-f]{64}$') "worktree-fingerprint did not return a sha256 for the sandbox repo: $fingerprint"
    $reviewResult = @"
$impactSurface

## Execution path and regression evidence
- path: A > B > C > D
- branches: error and retry
- evidence: full-path test

## Reviewer result
- result: PASS
- diff_sha256: $fingerprint
- Architecture consistency: PASS
- Code quality and conventions: PASS
- Data consistency: N/A - no data change
- Security: N/A - no security change
- Risk and compatibility: PASS
- Performance: N/A - no hot path change
- Flow and impact completeness: PASS
- Failure modes and observability: PASS
"@
    $adversarialResult = @"
## Adversarial result
- result: PASS
- diff_sha256: $fingerprint
- Provenance: PASS
- Pattern fan-out: PASS
- Engine semantics: PASS
- Cross-round accumulation: PASS
"@
    $verifierResult = "## Verifier result`n- PASS`n- diff_sha256: $fingerprint`n"
    $roleResults = $reviewResult + "`n" + $verifierResult

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
    # \r?$: this file is CRLF, so a bare $ anchor never matches and the substitution would
    # silently be a no-op, leaving a perfectly valid PASS line and asserting nothing.
    $reviewMalformedPass = $reviewResult -replace '(?m)^- result: PASS[ \t]*\r?$', "-`r`nresult:`r`nPASS"
    Set-TestTask $resolved @() ($reviewMalformedPass + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result is missing or not passed') 'multiline Reviewer PASS was accepted'
    $reviewCheckedDimensions = $reviewResult -replace '(?m)^- Architecture consistency: PASS[ \t]*\r?$', '- Architecture consistency: checked'
    Set-TestTask $resolved @() ($reviewCheckedDimensions + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Architecture consistency') 'Reviewer dimension without PASS was accepted'
    $reviewWithHistory = $reviewResult -replace '(?m)^- Risk and compatibility: PASS[ \t]*\r?$', '- Risk and compatibility: PASS - previous FAIL was resolved'
    Set-TestTask $resolved @() ($reviewWithHistory + "`n" + $verifierResult) $true
    Assert (-not (Invoke-Quality $repo)) 'Reviewer PASS explanation mentioning a previous FAIL was rejected'
    $reviewAmbiguousPass = $reviewResult -replace '(?m)^- Architecture consistency: PASS[ \t]*\r?$', '- Architecture consistency: PASS/FAIL'
    Set-TestTask $resolved @() ($reviewAmbiguousPass + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Architecture consistency') 'ambiguous PASS/FAIL Reviewer dimension was accepted'
    $reviewAmbiguousNA = $reviewResult -replace '(?m)^- Data consistency: N/A - no data change[ \t]*\r?$', '- Data consistency: N/A/FAIL'
    Set-TestTask $resolved @() ($reviewAmbiguousNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Data consistency') 'ambiguous N/A/FAIL Reviewer dimension was accepted'
    $reviewFlowNA = $reviewResult -replace '(?m)^- Flow and impact completeness: PASS[ \t]*\r?$', '- Flow and impact completeness: N/A'
    Set-TestTask $resolved @() ($reviewFlowNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result missing or not passed dimension: Flow and impact completeness') 'flow and impact completeness accepted N/A'
    Set-TestTask $resolved @() ($reviewResult + "`n## Verifier result`n- FAIL`n") $true
    Assert ((Invoke-Quality $repo) -match 'Verifier result is missing or not passed') 'failed Verifier result was accepted'
    Set-TestTask $resolved @() $roleResults $true
    Assert (-not (Invoke-Quality $repo)) 'valid code_change task was blocked'

    # --- eighth review dimension: failure modes must never be waived ---
    $reviewNoFailureModes = $reviewResult -replace '(?m)^- Failure modes and observability: PASS[ \t]*\r?$', ''
    Set-TestTask $resolved @() ($reviewNoFailureModes + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'dimension: Failure modes and observability') 'missing failure-modes dimension was accepted'
    $reviewFailureModesNA = $reviewResult -replace '(?m)^- Failure modes and observability: PASS[ \t]*\r?$', '- Failure modes and observability: N/A'
    Set-TestTask $resolved @() ($reviewFailureModesNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'dimension: Failure modes and observability') 'failure-modes dimension accepted N/A'

    # --- diff fingerprint: a verdict is only valid against the diff it was given ---
    $reviewNoFingerprint = $reviewResult -replace "(?m)^- diff_sha256: $fingerprint[ \t]*\r?$", ''
    Set-TestTask $resolved @() ($reviewNoFingerprint + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Reviewer result has no') 'Reviewer without a recorded diff fingerprint was accepted'
    $staleFingerprint = ('0' * 64)
    $reviewStale = $reviewResult -replace "(?m)^- diff_sha256: $fingerprint[ \t]*\r?$", "- diff_sha256: $staleFingerprint"
    Set-TestTask $resolved @() ($reviewStale + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'must be re-run') 'Reviewer verdict against a different diff was accepted'
    $verifierStale = $verifierResult -replace "(?m)^- diff_sha256: $fingerprint[ \t]*\r?$", "- diff_sha256: $staleFingerprint"
    Set-TestTask $resolved @() ($reviewResult + "`n" + $verifierStale) $true
    Assert ((Invoke-Quality $repo) -match 'Verifier result reviewed diff') 'Verifier verdict against a different diff was accepted'
    # An untracked file is invisible to `git diff`, which is exactly how three core files once
    # reached a review without being in it. It must move the fingerprint.
    $strayFile = Join-Path $repo 'stray.go'
    [IO.File]::WriteAllText($strayFile, 'package app', $utf8NoBom)
    try {
        Set-TestTask $resolved @() $roleResults $true
        Assert ((Invoke-Quality $repo) -match 'must be re-run') 'an untracked new file did not invalidate the recorded review'
    } finally {
        Remove-Item -LiteralPath $strayFile -Force
    }
    Set-TestTask $resolved @() $roleResults $true
    Assert (-not (Invoke-Quality $repo)) 'removing the stray file did not restore the original fingerprint'

    # --- adversarial round: gated for the six high-cost flags ---
    $dataWriteSections = "## Contract and data impact`nno schema change`n"
    Set-TestTask $resolved @('data_write') ($dataWriteSections + $roleResults) $true
    Assert ((Invoke-Quality $repo) -match 'Adversarial result is missing or not passed') 'data_write skipped the adversarial round'
    Set-TestTask $resolved @('data_write') ($dataWriteSections + $reviewResult + "`n" + $adversarialResult + "`n" + $verifierResult) $true
    Assert (-not (Invoke-Quality $repo)) 'valid data_write task with an adversarial round was blocked'
    $adversarialNA = $adversarialResult -replace '(?m)^- Engine semantics: PASS[ \t]*\r?$', '- Engine semantics: N/A'
    Set-TestTask $resolved @('data_write') ($dataWriteSections + $reviewResult + "`n" + $adversarialNA + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'check: Engine semantics') 'adversarial check accepted N/A'
    $adversarialStale = $adversarialResult -replace "(?m)^- diff_sha256: $fingerprint[ \t]*\r?$", "- diff_sha256: $staleFingerprint"
    Set-TestTask $resolved @('data_write') ($dataWriteSections + $reviewResult + "`n" + $adversarialStale + "`n" + $verifierResult) $true
    Assert ((Invoke-Quality $repo) -match 'Adversarial result reviewed diff') 'adversarial verdict against a different diff was accepted'

    # --- mutation check: proves the guarding test can actually fail ---
    $validDataWrite = $dataWriteSections + $reviewResult + "`n" + $adversarialResult + "`n" + $verifierResult
    Set-TestTask $resolved @('data_write') $validDataWrite $true
    $mutationTask = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $mutationContent = Get-Content -LiteralPath $mutationTask.FullName -Raw -Encoding UTF8
    [IO.File]::WriteAllText($mutationTask.FullName, ($mutationContent -replace '(?m)^- mutation check: PASS[ \t]*\r?\n', ''), $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'mutation check result must be') 'data_write without a mutation check was accepted'
    [IO.File]::WriteAllText($mutationTask.FullName, ($mutationContent -replace '(?m)^- mutation check: PASS[ \t]*\r?$', '- mutation check: SKIP'), $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'SKIP mutation check requires a reason') 'mutation check SKIP without a reason was accepted'

    # --- retrospective: a fix has to say whether it was a regression, and what missed it ---
    # This is the only gate that asks about the framework rather than the change. It runs at Close
    # only: a fix that stops half-way must still be able to end its turn.
    $retroPreExisting = @"
## Retrospective result
- introduced_by: unknown - git log -S on the guard found no earlier occurrence
- classification: pre_existing
"@
    # framework_change: recorded:<id> used to be shape-checked only, so any 8 hex digits passed and
    # the finding it claimed to point at never had to exist. The id now has to resolve in the retro
    # index, which means the fixture needs a real one seeded here.
    $retroIndexPath = Join-Path $state 'retro\index.json'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $retroIndexPath) | Out-Null
    [IO.File]::WriteAllText($retroIndexPath, (@{
        schema_version = 1
        updated_at = '2026-08-13T12:00:00+08:00'
        entries = @(@{
            id = '20260813-120000-abcd1234'
            created_at = '2026-08-13T12:00:00+08:00'
            task_id = '20260807-000000-hook-test'
            classification = 'regression'
            miss_category = 'impact_surface'
            summary = 'seeded finding so framework_change has something real to point at'
            status = 'open'
        })
    } | ConvertTo-Json -Depth 6), $utf8NoBom)

    $retroRegression = @"
## Retrospective result
- introduced_by: 0123456789abcdef0123456789abcdef01234567
- classification: regression
- miss_category: impact_surface
- gap_evidence: task 20260801-000000-earlier left Impact surface without the second caller
- framework_change: recorded:20260813-120000-abcd1234
"@

    # A code change with no change_kind cannot be classified at all, so it cannot close.
    Set-TestTask $resolved @() $roleResults $true
    Assert (-not (Invoke-Quality $repo)) 'a task without change_kind was blocked from merely stopping'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a code change without change_kind was allowed to close'
    Assert ($closeOutput.Text -match 'change_kind') 'close-task did not name the missing change_kind'

    # fix without the section
    Set-TestTask $resolved @() $roleResults $true 'fix'
    Assert (-not (Invoke-Quality $repo)) 'a fix without a retrospective was blocked from merely stopping'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a fix without a retrospective was allowed to close'
    Assert ($closeOutput.Text -match 'Retrospective result') 'close-task did not name the missing retrospective'

    # a placeholder section is not a retrospective
    Set-TestTask $resolved @() ($roleResults + "`n## Retrospective result`n<pending>`n") $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a placeholder retrospective was accepted'

    # not a regression: introduced_by and classification are enough
    Set-TestTask $resolved @() ($roleResults + "`n" + $retroPreExisting) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "a valid pre_existing retrospective was refused: $($closeOutput.Text)"

    # classification must come from the enum
    Set-TestTask $resolved @() ($roleResults + "`n" + ($retroPreExisting -replace 'pre_existing', 'probably not')) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'an unknown classification was accepted'
    Assert ($closeOutput.Text -match 'classification') 'close-task did not name the bad classification'

    # introduced_by cannot be left blank - filling classification alone is the cheap way out
    Set-TestTask $resolved @() ($roleResults + "`n## Retrospective result`n- classification: pre_existing`n") $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a retrospective without introduced_by was accepted'
    Assert ($closeOutput.Text -match 'introduced_by') 'close-task did not name the missing introduced_by'

    # a regression owes three more fields
    foreach ($dropped in @('miss_category', 'gap_evidence', 'framework_change')) {
        $partial = ($retroRegression -split "`r?`n" | Where-Object { $_ -notmatch "^- $dropped" }) -join "`n"
        Set-TestTask $resolved @() ($roleResults + "`n" + $partial) $true 'fix'
        $closeOutput = Invoke-CloseTask $repo
        Assert ($closeOutput.ExitCode -ne 0) "a regression without $dropped was accepted"
        Assert ($closeOutput.Text -match $dropped) "close-task did not name the missing $dropped"
    }
    # the category has to be one the framework actually knows how to act on
    Set-TestTask $resolved @() ($roleResults + "`n" + ($retroRegression -replace 'impact_surface', 'someone_was_careless')) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'an unknown miss_category was accepted'
    Assert ($closeOutput.Text -match 'miss_category') 'close-task did not name the bad miss_category'
    # framework_change must be a real disposition, not free text
    Set-TestTask $resolved @() ($roleResults + "`n" + ($retroRegression -replace 'recorded:20260813-120000-abcd1234', 'will think about it')) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'an unrecorded framework_change was accepted'
    Set-TestTask $resolved @() ($roleResults + "`n" + ($retroRegression -replace 'recorded:20260813-120000-abcd1234', 'not_needed - the gap is already covered by impact-guard')) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "a justified not_needed framework_change was refused: $($closeOutput.Text)"

    # a well-formed id that resolves to nothing is the cheap way to fake a recorded finding: the
    # shape check alone could not tell it from a real one, so the id has to be looked up.
    Set-TestTask $resolved @() ($roleResults + "`n" + ($retroRegression -replace 'abcd1234', 'deadbeef')) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a framework_change naming a non-existent retro finding was accepted'
    Assert ($closeOutput.Text -match 'no such finding exists') 'close-task did not say the retro finding is missing'

    # the full regression form closes
    Set-TestTask $resolved @() ($roleResults + "`n" + $retroRegression) $true 'fix'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "a complete regression retrospective was refused: $($closeOutput.Text)"

    # --- stop_reason: paused/blocked has to say what it is waiting for ---
    # Flipping status to paused used to be a free exit. The task dropped out of active_tasks and
    # with it every completion check, and nothing asked why. It stays an escape hatch, but a
    # documented one. Checked through the Stop hook because that is where the exit was taken.
    $stopTask = Join-Path $resolved.task_root '20260807-000000-hook-test\task.md'
    foreach ($stopStatus in @('paused', 'blocked')) {
        Set-TestTask $resolved @() $impactSurface $true 'chore'
        $stopContent = Get-Content -LiteralPath $stopTask -Raw -Encoding UTF8
        [IO.File]::WriteAllText($stopTask, ($stopContent -replace '(?m)^status: in_progress\r?$', "status: $stopStatus"), $utf8NoBom)
        $quality = Invoke-Quality $repo
        Assert ($quality -match 'stop_reason') "a $stopStatus task with no stop_reason was allowed to stop: $quality"

        # a placeholder is not a reason
        $stopContent = Get-Content -LiteralPath $stopTask -Raw -Encoding UTF8
        [IO.File]::WriteAllText($stopTask, ($stopContent -replace '(?m)^(updated_at:.*)$', "`$1`nstop_reason: <what is needed>"), $utf8NoBom)
        Assert ((Invoke-Quality $repo) -match 'stop_reason') "a placeholder stop_reason was accepted for $stopStatus"

        $stopContent = Get-Content -LiteralPath $stopTask -Raw -Encoding UTF8
        [IO.File]::WriteAllText($stopTask, ($stopContent -replace '(?m)^stop_reason:.*$', 'stop_reason: waiting on the staging database credentials'), $utf8NoBom)
        Assert (-not (Invoke-Quality $repo)) "a $stopStatus task with a real stop_reason was still blocked"
    }
    # superseded is the "not doing this" exit and needs no reason
    Set-TestTask $resolved @() $impactSurface $true 'chore'
    $stopContent = Get-Content -LiteralPath $stopTask -Raw -Encoding UTF8
    [IO.File]::WriteAllText($stopTask, ($stopContent -replace '(?m)^status: in_progress\r?$', 'status: superseded'), $utf8NoBom)
    Assert (-not (Invoke-Quality $repo)) 'a superseded task was asked for a stop_reason'

    # --- the freeze gate, now that `draft` is gone ---
    # SKILL.md used to say "start freeze-required tasks as draft". project-resolver only ever
    # collected in_progress tasks, so following that instruction made the task invisible to this
    # hook and to the Stop gate - the guards were off for exactly the window the freeze protects.
    # frozen_at is the gate instead: no freeze, no code.
    $sourceFile = Join-Path $repo 'app\x.go'
    Set-TestTask $resolved @('schema') $impactSurface $true 'feature'
    $frozenDeny = Invoke-ImpactGuard $repo $sourceFile
    Assert ($frozenDeny -match 'frozen_at') "a freeze-required task with no frozen_at was allowed to edit code: $frozenDeny"
    Assert ($frozenDeny -match 'schema') 'impact-guard did not name the freeze-required flag'
    Set-TestTask $resolved @('schema') $impactSurface $true 'feature' -Frozen
    Assert (-not (Invoke-ImpactGuard $repo $sourceFile)) 'a frozen freeze-required task was still blocked from editing code'
    # a task with no freeze-required flag never needed a freeze
    Set-TestTask $resolved @('behavior_change') $impactSurface $true 'feature'
    Assert (-not (Invoke-ImpactGuard $repo $sourceFile)) 'a task with no freeze-required flag was asked for frozen_at'

    # --- roles_waived is the user's decision, not the agent's ---
    Set-TestTask $resolved @() $impactSurface $true 'chore'
    $waiveDeny = Invoke-ImpactGuardWrite $repo $stopTask "updated_at: 2026-08-07T00:00:00+08:00`nroles_waived: skipping for speed"
    Assert ($waiveDeny -match 'waive-roles\.ps1') "a direct roles_waived write was allowed: $waiveDeny"
    # the sanctioned path refuses without explicit user confirmation
    $waiveScript = Join-Path $root 'scripts\waive-roles.ps1'
    Assert (Test-Path -LiteralPath $waiveScript) 'scripts\waive-roles.ps1 is missing'
    $unconfirmed = Invoke-Native $hostExe @('-NoProfile','-ExecutionPolicy','Bypass','-File',$waiveScript,'-Reason','because','-Path',$repo,'-StateRoot',$state)
    Assert ($unconfirmed.Code -ne 0) 'waive-roles wrote a waiver without -ConfirmedByUser'
    $confirmed = Invoke-Native $hostExe @('-NoProfile','-ExecutionPolicy','Bypass','-File',$waiveScript,'-Reason','user asked for a single-dialogue run','-ConfirmedByUser','-Path',$repo,'-StateRoot',$state)
    Assert ($confirmed.Code -eq 0) "waive-roles refused a confirmed waiver: $($confirmed.Text)"
    Assert ((Get-Content -LiteralPath $stopTask -Raw -Encoding UTF8) -match '(?m)^roles_waived: user asked for a single-dialogue run\r?$') 'waive-roles did not record the reason in frontmatter'
    # and it will not silently overwrite an existing waiver
    $again = Invoke-Native $hostExe @('-NoProfile','-ExecutionPolicy','Bypass','-File',$waiveScript,'-Reason','second try','-ConfirmedByUser','-Path',$repo,'-StateRoot',$state)
    Assert ($again.Code -ne 0) 'waive-roles overwrote an existing waiver'

    # every other change kind is untouched by this gate
    foreach ($kind in @('feature', 'chore')) {
        Set-TestTask $resolved @() $roleResults $true $kind
        $closeOutput = Invoke-CloseTask $repo
        Assert ($closeOutput.ExitCode -eq 0) "change_kind $kind was asked for a retrospective: $($closeOutput.Text)"
    }
    # refactor is exempt from the retrospective gate same as the others, but change_kind: refactor
    # is itself the trigger for Behavior invariants and before-after evidence (moved off the
    # retired risk_flags: refactor - see risk-flags.md), so this fixture needs that section too.
    $refactorResults = $roleResults + "`n`n## Behavior invariants and before-after evidence`nexternal behavior unchanged; before/after outputs identical for the sandbox fixture"
    Set-TestTask $resolved @() $refactorResults $true 'refactor'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "change_kind refactor was asked for a retrospective: $($closeOutput.Text)"

    # a worker is one slice of a fix; the coordinator does the retrospective once, for the whole.
    # A worker's fingerprint is taken against its base_commit, so the base has to be a real commit
    # in this sandbox and the role sections have to carry that same value - a made-up sha would
    # fail on the fingerprint instead of proving anything about the retrospective.
    $workerBaseCommit = (& git -C $repo rev-parse HEAD).Trim()
    $workerFingerprint = ((& (Join-Path $root 'scripts\worktree-fingerprint.ps1') -Path $repo -Base $workerBaseCommit | Out-String) | ConvertFrom-Json).sha256
    Assert ($workerFingerprint -match '^[0-9a-f]{64}$') "worktree-fingerprint did not return a sha256 for a based diff: $workerFingerprint"
    $workerRoleResults = $roleResults -replace $fingerprint, $workerFingerprint
    Set-TestTask $resolved @() $workerRoleResults $true 'fix'
    $workerTask = (Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1).FullName
    $workerContent = Get-Content -LiteralPath $workerTask -Raw -Encoding UTF8
    $workerFrontmatter = @(
        'subtask_role: worker'
        'parent_task_id: 20260807-000000-coordinator'
        "base_commit: $workerBaseCommit"
        'file_ownership: [app/]'
        'delivery_status: pending'
    ) -join "`n"
    [IO.File]::WriteAllText($workerTask, ($workerContent -replace '(?m)^(frozen_at:.*)$', "`$1`n$workerFrontmatter"), $utf8NoBom)
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "a worker slice of a fix was asked for its own retrospective: $($closeOutput.Text)"

    # --- the finish line: status done only through close-task.ps1 ---
    Set-TestTask $resolved @() $roleResults $true
    $closeTargetTask = (Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1).FullName
    $doneWrite = "---`nstatus: done`n---`n"
    Assert ((Invoke-ImpactGuardWrite $repo $closeTargetTask $doneWrite) -match 'close-task\.ps1') 'a direct status: done write was allowed'
    Assert ((Invoke-ImpactGuardEdit $repo $closeTargetTask 'status: done') -match 'close-task\.ps1') 'a direct status: done edit was allowed'
    Assert ((Invoke-ImpactGuardAntigravityEdit $repo $closeTargetTask 'status: done') -match 'close-task\.ps1') 'Antigravity bypassed the status: done gate'
    $donePatch = "*** Begin Patch`n*** Update File: " + $closeTargetTask.Replace('\','/') + "`n@@`n-status: in_progress`n+status: done`n*** End Patch"
    Assert ((Invoke-ImpactGuardCodex $repo $donePatch) -match 'close-task\.ps1') 'Codex apply_patch bypassed the status: done gate'
    # Stopping without finishing must stay frictionless.
    Assert (-not (Invoke-ImpactGuardEdit $repo $closeTargetTask 'status: paused')) 'pausing a task was blocked'
    Assert (-not (Invoke-ImpactGuardEdit $repo $closeTargetTask 'status: blocked')) 'blocking a task was blocked'

    # close-task refuses an incomplete task and leaves the file untouched
    Set-TestTask $resolved @() ($reviewResult + "`n## Verifier result`n- FAIL`n") $true
    $closeTargetTask = (Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1).FullName
    $beforeClose = Get-Content -LiteralPath $closeTargetTask -Raw -Encoding UTF8
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'close-task closed a task whose Verifier had failed'
    Assert ($closeOutput.Text -match 'Verifier result') 'close-task did not report why it refused'
    Assert ((Get-Content -LiteralPath $closeTargetTask -Raw -Encoding UTF8) -eq $beforeClose) 'close-task modified the task file after refusing'

    # close-task closes a complete task
    Set-TestTask $resolved @() $roleResults $true 'chore'
    $closeTargetTask = (Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1).FullName
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "close-task refused a complete task: $($closeOutput.Text)"
    Assert ((Get-Content -LiteralPath $closeTargetTask -Raw -Encoding UTF8) -match '(?m)^status: done[ \t]*\r?$') 'close-task did not write status: done'

    # --- roles that never ran cannot be signed off by the main agent ---
    Set-TestTask $resolved @() $roleResults $true 'chore'
    $degradedTask = (Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1).FullName
    $degradedContent = Get-Content -LiteralPath $degradedTask -Raw -Encoding UTF8
    [IO.File]::WriteAllText($degradedTask, ($degradedContent -replace '(?m)^(frozen_at:.*)$', "`$1`nindependence: degraded"), $utf8NoBom)
    Assert (-not (Invoke-Quality $repo)) 'a degraded task was blocked from merely stopping'
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -ne 0) 'a degraded task was allowed to close'
    Assert ($closeOutput.Text -match 'degraded') 'close-task did not name degraded independence as the reason'
    # The only way out is an explicit, user-authorised waiver recorded in frontmatter.
    $waivedContent = Get-Content -LiteralPath $degradedTask -Raw -Encoding UTF8
    [IO.File]::WriteAllText($degradedTask, ($waivedContent -replace '(?m)^(independence: degraded)$', "`$1`nroles_waived: user asked for a single-dialogue run"), $utf8NoBom)
    $closeOutput = Invoke-CloseTask $repo
    Assert ($closeOutput.ExitCode -eq 0) "an explicitly waived task was still refused: $($closeOutput.Text)"
    Assert ($closeOutput.Text -match 'waived') 'close-task did not surface the waiver at the moment of closing'

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

    # --- Project docs: read: gate, checked one step after Impact surface in the same guard ---
    $validImpactOnly = "## Impact surface`n- callers: rg X 3 hits, app/x.go:1`n- entrypoints: none`n- shared state: none`n- unverified: none`n"
    Set-TestTask $resolved @() $validImpactOnly $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'Project docs') 'impact-guard allowed a code edit with Impact surface filled but the Project docs section missing entirely'
    $projectDocsQuality = Invoke-Quality $repo
    Assert ($projectDocsQuality -match 'Project docs') 'quality-gate did not require Project docs for a task with no Project docs section'

    Set-TestTask $resolved @() ("## Project docs`n- read: <doc paths>`n- updated: none`n`n" + $validImpactOnly) $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'Project docs') 'impact-guard accepted an untouched Project docs read: placeholder'

    $missingDocPath = 'docs/does-not-exist.md'
    Set-TestTask $resolved @() ("## Project docs`n- read: $missingDocPath`n- updated: none`n`n" + $validImpactOnly) $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'does not exist') 'impact-guard accepted a read: path that does not exist in the repo'
    Assert ((Invoke-Quality $repo) -match 'does not exist') 'quality-gate accepted a read: path that does not exist in the repo'

    Set-TestTask $resolved @() ("## Project docs`n- read: none - <reason>`n- updated: none`n`n" + $validImpactOnly) $true
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'placeholder') "impact-guard accepted 'none - <reason>' with the reason left as a placeholder"
    Assert ((Invoke-Quality $repo) -match 'placeholder') "quality-gate accepted 'none - <reason>' with the reason left as a placeholder"

    # $impactSurface's own Project docs section already is a genuine 'none - <reason>'
    # disposition, and every "valid code_change task" assertion elsewhere in this file already
    # exercises it end to end (impact-guard AND quality-gate) via $reviewResult/$roleResults - no
    # separate positive fixture needed here.
    Set-TestTask $resolved @() ("## Project docs`n- read: none - project has no docs yet`n- updated: none`n`n" + $validImpactOnly) $true
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) "impact-guard blocked a genuine 'none - <reason>' disposition"

    # a real doc path is accepted too, not just the none - <reason> escape hatch. Written and
    # removed within this block: later in this file $repo's fingerprint is expected to be exactly
    # what it was after the fixture commit, the same invariant the stray.go check further below
    # relies on.
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'docs') | Out-Null
    $projectDocFixture = Join-Path $repo 'docs\architecture.md'
    [IO.File]::WriteAllText($projectDocFixture, 'test doc', $utf8NoBom)
    try {
        Set-TestTask $resolved @() ("## Project docs`n- read: docs/architecture.md`n- updated: none`n`n" + $validImpactOnly) $true
        Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'impact-guard blocked read: naming a doc path that actually exists'
    } finally {
        Remove-Item -LiteralPath $projectDocFixture -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $repo 'docs') -Force -Recurse -ErrorAction SilentlyContinue
    }

    # code_change: false is untouched by either gate.
    Set-TestTask $resolved @()
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'impact-guard applied the Project docs gate to a code_change: false task'
    Assert (-not (Invoke-Quality $repo)) 'quality-gate applied the Project docs gate to a code_change: false task'

    # --- Project docs: updated:, Close-only and conditional on change_kind / risk_flags ---
    # Untriggered (chore, no doc-relevant flag): not checked at all. $roleResults already carries
    # 'none - test fixture, no structural change' and every other Close test in this file already
    # exercises that path successfully.
    Set-TestTask $resolved @() $roleResults $true 'chore'
    $untriggeredOutput = Invoke-CloseTask $repo
    Assert ($untriggeredOutput.ExitCode -eq 0) "close-task refused an untriggered (chore) task over updated:: $($untriggeredOutput.Text)"

    # change_kind: feature triggers it. Missing / placeholder / bare 'none' (no reason) all refuse.
    $updatedMissing = $roleResults -replace '(?m)^- updated:.*\r?\n', ''
    Set-TestTask $resolved @() $updatedMissing $true 'feature'
    $missingOutput = Invoke-CloseTask $repo
    Assert ($missingOutput.ExitCode -ne 0) 'a triggered (feature) task with no updated: line was allowed to close'
    Assert ($missingOutput.Text -match 'updated') "close-task did not name the missing updated: line: $($missingOutput.Text)"

    $updatedPlaceholder = $roleResults -replace '(?m)^- updated:.*\r?$', '- updated: <doc paths>'
    Set-TestTask $resolved @() $updatedPlaceholder $true 'feature'
    Assert ((Invoke-CloseTask $repo).ExitCode -ne 0) 'a triggered (feature) task with an untouched updated: placeholder was allowed to close'

    $updatedBareNone = $roleResults -replace '(?m)^- updated:.*\r?$', '- updated: none'
    Set-TestTask $resolved @() $updatedBareNone $true 'feature'
    Assert ((Invoke-CloseTask $repo).ExitCode -ne 0) 'a triggered (feature) task with a bare updated: none (no reason) was allowed to close'

    $updatedNonePlaceholderReason = $roleResults -replace '(?m)^- updated:.*\r?$', '- updated: none - <reason>'
    Set-TestTask $resolved @() $updatedNonePlaceholderReason $true 'feature'
    Assert ((Invoke-CloseTask $repo).ExitCode -ne 0) "a triggered (feature) task with 'none - <reason>' left as a placeholder was allowed to close"

    # A genuine reason is accepted - a structural change can legitimately have nothing to document.
    $updatedGenuineNone = $roleResults -replace '(?m)^- updated:.*\r?$', '- updated: none - internal refactor only, no observable behavior or entrypoint changed'
    Set-TestTask $resolved @() $updatedGenuineNone $true 'feature'
    $genuineNoneOutput = Invoke-CloseTask $repo
    Assert ($genuineNoneOutput.ExitCode -eq 0) "a triggered (feature) task with a genuine 'none - <reason>' disposition was refused: $($genuineNoneOutput.Text)"

    # A real path is accepted; a nonexistent one is refused - same Test-Path check read: uses.
    # Writing the fixture file changes $repo's fingerprint out from under both $roleResults'
    # recorded diff_sha256 AND Set-TestTask's own embedded pre-review line (it bakes in
    # $script:fingerprint directly, separately from $Extra) - recompute and substitute both,
    # rather than let the fingerprint gate mask the assertion this block actually wants to make.
    New-Item -ItemType Directory -Force -Path (Join-Path $repo 'docs') | Out-Null
    $updateDocFixture = Join-Path $repo 'docs\updated-fixture.md'
    [IO.File]::WriteAllText($updateDocFixture, 'test doc', $utf8NoBom)
    $fingerprintBeforeDocFixture = $fingerprint
    try {
        $fingerprint = ((& (Join-Path $root 'scripts\worktree-fingerprint.ps1') -Path $repo | Out-String) | ConvertFrom-Json).sha256
        Assert ($fingerprint -match '^[0-9a-f]{64}$') "worktree-fingerprint did not return a sha256 with the doc fixture present: $fingerprint"

        $updatedRealPath = ($roleResults -replace $fingerprintBeforeDocFixture, $fingerprint) -replace '(?m)^- updated:.*\r?$', '- updated: docs/updated-fixture.md'
        Set-TestTask $resolved @() $updatedRealPath $true 'feature'
        $realPathOutput = Invoke-CloseTask $repo
        Assert ($realPathOutput.ExitCode -eq 0) "close-task refused updated: naming a doc path that actually exists: $($realPathOutput.Text)"

        $updatedMissingPath = ($roleResults -replace $fingerprintBeforeDocFixture, $fingerprint) -replace '(?m)^- updated:.*\r?$', '- updated: docs/does-not-exist-either.md'
        Set-TestTask $resolved @() $updatedMissingPath $true 'feature'
        Assert ((Invoke-CloseTask $repo).ExitCode -ne 0) 'close-task accepted updated: naming a doc path that does not exist'
    } finally {
        Remove-Item -LiteralPath $updateDocFixture -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $repo 'docs') -Force -Recurse -ErrorAction SilentlyContinue
        $fingerprint = $fingerprintBeforeDocFixture
    }

    # risk_flags alone can trigger it too, independent of change_kind (chore here would not).
    $updatedMissingChore = $roleResults -replace '(?m)^- updated:.*\r?\n', ''
    $behaviorChangeContent = "## Acceptance cases`nA1`n`n" + $updatedMissingChore
    Set-TestTask $resolved @('behavior_change') $behaviorChangeContent $true 'chore'
    Assert ((Invoke-CloseTask $repo).ExitCode -ne 0) 'risk_flags: behavior_change did not trigger the updated: check on a chore task'

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
    $taskContent = $taskContent -replace '(?m)^code_change: false[ \t]*\r?$', 'code_change: maybe'
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'code_change must be true or false') 'invalid code_change was accepted'
    $taskContent = $taskContent -replace '(?m)^code_change: maybe\r?\n', ''
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'missing required field: code_change') 'missing code_change was accepted'

    Set-TestTask $resolved @() ''
    $taskPath = Get-ChildItem -LiteralPath $resolved.task_root -Recurse -Filter task.md | Select-Object -First 1
    $taskContent = Get-Content -LiteralPath $taskPath.FullName -Raw -Encoding UTF8
    $taskContent = $taskContent -replace '(?m)^- pre-review: PASS[ \t]*\r?$', '- pre-review: SKIP' -replace '(?m)^- skip reason: none[ \t]*\r?$', '- skip reason: <reason>'
    [IO.File]::WriteAllText($taskPath.FullName, $taskContent, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'SKIP pre-review requires a reason') 'SKIP without a reason was accepted'

    # ================================================================
    # Phase 3: coordinator/worker role awareness
    # ================================================================

    function New-OrchestrationTask([string]$TaskRoot, [string]$Id, [string]$ProjectId, [string]$WorktreeId, [hashtable]$ExtraFrontmatter, [string]$Body, [string]$CompletionCriteria = "- [x] complete") {
        $dir = Join-Path $TaskRoot $Id
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $extraLines = ($ExtraFrontmatter.Keys | ForEach-Object { "$($_): $($ExtraFrontmatter[$_])" }) -join "`n"
        $content = @"
---
id: $Id
project_id: $ProjectId
worktree_id: $WorktreeId
status: in_progress
code_change: true
risk_flags: []
created_at: 2026-08-12T00:00:00+08:00
updated_at: 2026-08-12T00:00:00+08:00
$extraLines
---

## Goal
Goal text

## Scope
Scope text

## Completion criteria
$CompletionCriteria

$Body
"@
        [IO.File]::WriteAllText((Join-Path $dir 'task.md'), $content, $utf8NoBom)
        return (Join-Path $dir 'task.md')
    }

    # --- coordinator: main worktree source edits denied unconditionally ---

    Get-ChildItem -LiteralPath $resolved.task_root -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    $coordId = '20260812-000000-coord'
    # A real coordinator's own criteria genuinely cannot all be checked off while workers are
    # still running (e.g. "all workers applied and integration verified") - the fixture must
    # reflect that, or the waiting-early-return test below would pass by accident regardless of
    # whether the unchecked-items check is actually role-aware.
    $coordCriteria = "- [ ] all workers applied and integration verified"
    $coordTaskPath = New-OrchestrationTask $resolved.task_root $coordId $resolved.project_id $resolved.worktree_id `
        @{ subtask_role = 'coordinator'; integration_status = 'pending' } `
        "## Decomposition plan`ntwo workers`n## Worker results`npending`n## Delivery log`npending`n## Integration verification`npending`n" `
        $coordCriteria
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'must not edit source directly') 'coordinator was allowed to edit main worktree source with an unfilled impact surface'
    # The deny must be unconditional - filling the impact surface must not unlock it.
    $coordContent = Get-Content -LiteralPath $coordTaskPath -Raw -Encoding UTF8
    [IO.File]::WriteAllText($coordTaskPath, ($coordContent + "`n$impactSurface`n"), $utf8NoBom)
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'must not edit source directly') 'coordinator was allowed to edit main worktree source after filling the impact surface'
    # A coordinator must still be able to write its own task file.
    Assert (-not (Invoke-ImpactGuard $repo $coordTaskPath)) 'impact-guard deadlocked the coordinator task file'

    # coordinator: waiting on a non-terminal worker is a legitimate stop, not a block. The
    # roster is discovered via parent_task_id, so a worker task must actually exist and still
    # be in_progress for "waiting" to be true (an empty roster is not "waiting", it is "done").
    # The worker needs its OWN worktree_id (a real worker lives in a separate worktree) -
    # reusing the coordinator's would make project-resolver see two in_progress tasks for the
    # same worktree and block on "multiple in_progress tasks" before role logic ever runs.
    $waitingWorkerId = '20260812-000200-worker-wip'
    $fakeWorkerWorktreeId = 'deadbeefdeadbeef'
    New-OrchestrationTask $resolved.task_root $waitingWorkerId $resolved.project_id $fakeWorkerWorktreeId `
        @{ subtask_role = 'worker'; parent_task_id = $coordId; base_commit = '0123456789abcdef0123456789abcdef01234567'; file_ownership = '[src/]'; delivery_status = 'pending' } `
        "## Parent task`n$coordId`n## File ownership`nsrc/`n" | Out-Null
    Assert (-not (Invoke-Quality $repo)) 'waiting coordinator with a non-terminal worker was blocked instead of allowed to stop'

    # coordinator: conflicted must never pass. It is not 'pending', so the waiting early return
    # no longer applies and the full completion check - including this state - kicks in.
    $conflicted = $coordContent -replace '(?m)^integration_status: pending[ \t]*\r?$', 'integration_status: conflicted'
    [IO.File]::WriteAllText($coordTaskPath, $conflicted, $utf8NoBom)
    Assert ((Invoke-Quality $repo) -match 'conflicted|applied') 'conflicted coordinator was allowed to stop cleanly'

    # coordinator: the hand-merge exception. While integration_status is conflicted, the paths
    # orchestrate.ps1 recorded in orchestration.json become editable - and nothing else does.
    $coordOrchestration = Join-Path (Split-Path -Parent $coordTaskPath) 'orchestration.json'
    $conflictPayload = @{
        coordinator_task_id = $coordId
        base_commit = '0123456789abcdef0123456789abcdef01234567'
        conflicts = @(@{ worker = '20260812-000200-worker-wip'; reason = 'overlaps'; paths = @('app/x.go') })
    } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($coordOrchestration, $conflictPayload, $utf8NoBom)
    Assert (-not (Invoke-ImpactGuard $repo $codeFile)) 'coordinator was blocked from merging a recorded conflict path'
    $otherFile = Join-Path $repo 'app\y.go'
    Assert ((Invoke-ImpactGuard $repo $otherFile) -match 'only edit the conflicting paths') 'coordinator was allowed to edit a path outside the recorded conflict'
    # The exception closes itself: once every conflict is resolved the list empties.
    $emptyPayload = @{ coordinator_task_id = $coordId; base_commit = '0123456789abcdef0123456789abcdef01234567'; conflicts = @() } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($coordOrchestration, $emptyPayload, $utf8NoBom)
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'must not edit source directly') 'coordinator kept source write access after the conflict list emptied'
    # ... and it does not apply at all outside the conflicted state.
    [IO.File]::WriteAllText($coordOrchestration, $conflictPayload, $utf8NoBom)
    [IO.File]::WriteAllText($coordTaskPath, $coordContent, $utf8NoBom)
    Assert ((Invoke-ImpactGuard $repo $codeFile) -match 'must not edit source directly') 'a recorded conflict unlocked source edits while integration_status was still pending'
    Remove-Item -LiteralPath $coordOrchestration -Force

    # Restore pending + the still-open worker for the impact-guard checks that follow.
    [IO.File]::WriteAllText($coordTaskPath, $coordContent, $utf8NoBom)

    # --- worker: own worktree, own task dir, sibling task dir, git allowlist ---

    $workerRepo = Join-Path $sandbox 'worker-repo'
    New-Item -ItemType Directory -Force -Path $workerRepo | Out-Null
    & git -C $workerRepo init --quiet
    [IO.File]::WriteAllText((Join-Path $workerRepo 'fixture.txt'), 'fixture', $utf8NoBom)
    & git -C $workerRepo add fixture.txt
    & git -C $workerRepo -c user.name=agent-workflow -c user.email=agent-workflow@example.invalid commit --quiet -m fixture
    $workerResolved = (& $resolverPath -Path $workerRepo -StateRoot $state -Ensure | Out-String) | ConvertFrom-Json
    $workerId = '20260812-000100-worker'
    $workerCodeFile = Join-Path $workerRepo 'app\x.go'
    $workerTaskPath = New-OrchestrationTask $workerResolved.task_root $workerId $workerResolved.project_id $workerResolved.worktree_id `
        @{ subtask_role = 'worker'; parent_task_id = $coordId; base_commit = '0123456789abcdef0123456789abcdef01234567'; file_ownership = '[app/]'; delivery_status = 'pending' } `
        "## Parent task`n$coordId`n## File ownership`napp/`n"

    # Own worktree: behaves exactly like a plain code_change:true task (gated by impact surface).
    Assert ((Invoke-ImpactGuard $workerRepo $workerCodeFile) -match 'Impact surface') 'worker was allowed to edit its own worktree before filling the impact surface'
    $workerContent = Get-Content -LiteralPath $workerTaskPath -Raw -Encoding UTF8
    [IO.File]::WriteAllText($workerTaskPath, ($workerContent + "`n$impactSurface`n"), $utf8NoBom)
    Assert (-not (Invoke-ImpactGuard $workerRepo $workerCodeFile)) 'worker was blocked from editing its own worktree after filling the impact surface'
    # Own task directory must stay writable, or the worker could never close out its own task.
    Assert (-not (Invoke-ImpactGuard $workerRepo $workerTaskPath)) 'impact-guard deadlocked the worker task file'
    # A sibling task's directory (here: the coordinator's, reachable under the same state root
    # once both repos share $env:USERPROFILE) must be denied.
    Assert ((Invoke-ImpactGuard $workerRepo $coordTaskPath) -match 'out of lane') 'worker was allowed to write into another task''s directory'
    # `feature` vs `feature-old`: StartsWith without a separator boundary would conflate these.
    $siblingLookalike = $workerResolved.task_root + '-old\task.md'
    Assert ((Invoke-ImpactGuard $workerRepo $siblingLookalike) -match 'out of lane|Impact surface') 'a lookalike task_root path was not evaluated as out of scope'

    # --- git-guard: worker read-only allowlist ---

    function Invoke-GuardAt([string]$Cwd, [string]$Command) {
        $payload = @{ cwd = $Cwd; workspacePaths = @($Cwd); tool_input = @{ command = $Command } } | ConvertTo-Json -Compress
        return Invoke-HookUtf8 $guard $payload
    }

    Assert (-not (Invoke-GuardAt $workerRepo 'git status')) 'worker git-guard blocked a read-only status'
    Assert (-not (Invoke-GuardAt $workerRepo 'git diff HEAD')) 'worker git-guard blocked git diff HEAD'
    Assert (-not (Invoke-GuardAt $workerRepo 'git log -n 5 --oneline')) 'worker git-guard blocked git log -n 5 --oneline'
    Assert (-not (Invoke-GuardAt $workerRepo 'git -C . diff --name-only HEAD')) 'worker git-guard did not recognise git -C <path> diff'
    Assert (-not (Invoke-GuardAt $workerRepo 'git --no-pager log -n 1 --oneline')) 'worker git-guard did not recognise git --no-pager log'
    Assert ((Invoke-GuardAt $workerRepo 'git add -A') -match 'deny') 'worker git-guard allowed git add'
    Assert ((Invoke-GuardAt $workerRepo 'git branch feature') -match 'deny') 'worker git-guard allowed git branch'
    Assert ((Invoke-GuardAt $workerRepo 'git switch -c feature') -match 'deny') 'worker git-guard allowed git switch'
    Assert ((Invoke-GuardAt $workerRepo 'git config --local user.name x') -match 'deny') 'worker git-guard allowed git config --local'
    Assert ((Invoke-GuardAt $workerRepo 'git commit -m x') -match 'deny') 'worker git-guard allowed git commit (must deny, not ask - no one may be present to answer)'
    Assert ((Invoke-GuardAt $workerRepo 'git diff --output x.patch') -match 'deny') 'worker git-guard allowed git diff --output (a read subcommand made to write)'
    Assert ((Invoke-GuardAt $workerRepo 'git -c core.pager=calc log') -match 'deny') 'worker git-guard allowed git -c (arbitrary config injection)'
    Assert ((Invoke-GuardAt $workerRepo 'git status && git add -A') -match 'deny') 'worker git-guard allowed a && chain where one segment is not allowlisted'
    Assert ((Invoke-GuardAt $workerRepo 'git diff | Select-String x') -match 'deny') 'worker git-guard allowed a Git pipeline'

    # --- git-guard: coordinator allowlist ---

    Assert (-not (Invoke-GuardAt $repo 'git status')) 'coordinator git-guard blocked a read-only status'
    Assert (-not (Invoke-GuardAt $repo 'git diff HEAD')) 'coordinator git-guard blocked git diff HEAD'
    Assert ((Invoke-GuardAt $repo 'git apply delivery.patch') -match 'deny') 'coordinator git-guard allowed direct git apply'
    Assert ((Invoke-GuardAt $repo 'git worktree add x') -match 'deny') 'coordinator git-guard allowed direct git worktree'
    Assert ((Invoke-GuardAt $repo 'git add -A') -match 'deny') 'coordinator git-guard allowed git add'
    Assert ((Invoke-GuardAt $repo 'git restore x') -match 'deny') 'coordinator git-guard allowed git restore'
    Assert ((Invoke-GuardAt $repo 'git reset') -match 'deny') 'coordinator git-guard allowed git reset'

    # --- plain task: pipe/allowlist behaviour must stay exactly as before ---

    Get-ChildItem -LiteralPath $resolved.task_root -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Assert (-not (Invoke-GuardAt $repo 'git diff | Select-String x')) 'a plain task''s git-guard behaviour changed for a piped read-only command'
    Assert ((Invoke-GuardAt $repo 'git commit -m x') -match 'ask') 'a plain task''s git-guard no longer asks for git commit'
} finally {
    $env:USERPROFILE = $oldProfile
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
Write-Output 'hook tests passed'
