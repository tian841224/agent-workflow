$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-installer-' + [guid]::NewGuid().ToString('N'))
$claude = Join-Path $sandbox '.claude'
$codex = Join-Path $sandbox '.codex'
$gemini = Join-Path $sandbox '.gemini'
$state = Join-Path $sandbox '.agent-workflow'
$legacy = Join-Path $sandbox '.agents'
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$managedHooksDir = Join-Path $state 'runtime\hooks'
$customCommand = 'powershell.exe -NoProfile -File "C:\custom\user-hook.ps1"'

function Write-TestJson([string]$Path, $Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

function Write-MixedHookFixture([string]$Path, [string]$Matcher) {
    $data = [ordered]@{
        hooks = [ordered]@{
            PreToolUse = @([ordered]@{ matcher=$Matcher; hooks=@(
                $null,
                [ordered]@{ type='command'; command=$customCommand; timeout=5 },
                [ordered]@{ type='command'; command=('powershell.exe -File "' + (Join-Path $managedHooksDir 'git-guard.ps1') + '"'); timeout=15 }
            ) })
            Stop = @([ordered]@{ hooks=@(
                $null,
                [ordered]@{ type='command'; command=$customCommand; timeout=5 },
                [ordered]@{ type='command'; command=('powershell.exe -File "' + (Join-Path $managedHooksDir 'quality-gate.ps1') + '"'); timeout=15 }
            ) })
        }
    }
    Write-TestJson $Path $data
}

function Get-HookCommands($Config, [string]$EventName) {
    return @($Config.hooks.$EventName | ForEach-Object { @($_.hooks) | ForEach-Object { [string]$_.command } })
}

function Assert-NoNullHooks($Config, [string]$Path) {
    foreach ($eventName in @('PreToolUse','Stop')) {
        foreach ($entry in @($Config.hooks.$eventName)) {
            if ($null -eq $entry) { throw "null $eventName wrapper was retained: $Path" }
            foreach ($hook in @($entry.hooks)) {
                if ($null -eq $hook) { throw "nested null $eventName hook was retained: $Path" }
            }
        }
    }
}

try {
    Write-MixedHookFixture (Join-Path $claude 'settings.json') 'Bash|PowerShell'
    Write-MixedHookFixture (Join-Path $codex 'hooks.json') '^Bash$|^shell_command$'
    Write-TestJson (Join-Path $gemini 'config\hooks.json') ([ordered]@{
        'user-custom' = [ordered]@{ Stop=@([ordered]@{ type='command'; command=$customCommand; timeout=5 }) }
        'agent-workflow-stale' = [ordered]@{ Stop=@([ordered]@{ type='command'; command='stale'; timeout=5 }) }
    })

    & (Join-Path $root 'install.ps1') -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -LegacyRoot $legacy
    if ($LASTEXITCODE) { throw 'installer failed' }
    foreach ($path in @(
        (Join-Path $claude 'agents\agent-workflow-reviewer.md'),
        (Join-Path $codex 'agents\agent-workflow-reviewer.toml'),
        (Join-Path $gemini 'config\agents\agent-workflow-reviewer\agent.md'),
        (Join-Path $state 'runtime\hooks\quality-gate.ps1'),
        (Join-Path $state 'runtime\scripts\pre-review.ps1')
    )) { if (-not (Test-Path -LiteralPath $path)) { throw "missing installed file: $path" } }
    $installedPreReview = Join-Path $state 'runtime\scripts\pre-review.ps1'
    $preReviewOutput = & $hostExe -NoProfile -ExecutionPolicy Bypass -File $installedPreReview -RepoRoot $sandbox | Out-String
    if ($LASTEXITCODE -ne 0 -or $preReviewOutput -notmatch 'RESULT: SKIP') { throw 'installed pre-review runtime is not executable' }
    $installedSchema = Get-Content -LiteralPath (Join-Path $state 'runtime\schemas\task.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($installedSchema.required) -notcontains 'code_change' -or $installedSchema.properties.code_change.type -ne 'boolean') { throw 'installed task schema is missing code_change' }
    $installedWorkflow = Get-Content -LiteralPath (Join-Path $state 'runtime\skills\workflow\SKILL.md') -Raw -Encoding UTF8
    if ($installedWorkflow -notmatch 'code_change: true' -or $installedWorkflow -notmatch 'code_change: false') { throw 'installed workflow is missing code_change role rules' }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $codex 'agents\agent-workflow-reviewer.toml'))
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw 'Codex TOML has a BOM' }

    foreach ($action in @('Install','Repair')) {
        & (Join-Path $root 'install.ps1') -Action $action -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -LegacyRoot $legacy
        if ($LASTEXITCODE) { throw "installer $action failed" }
    }
    foreach ($path in @((Join-Path $claude 'settings.json'),(Join-Path $codex 'hooks.json'))) {
        $hookConfig = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-NoNullHooks $hookConfig $path
        $preCommands = Get-HookCommands $hookConfig 'PreToolUse'
        $stopCommands = Get-HookCommands $hookConfig 'Stop'
        if (@($hookConfig.hooks.PreToolUse).Count -ne 2) { throw "unexpected PreToolUse wrapper count after Repair: $path" }
        if (@($hookConfig.hooks.Stop).Count -ne 2) { throw "unexpected Stop wrapper count after Repair: $path" }
        if (@($preCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne 1) { throw "duplicate managed PreToolUse hook after Repair: $path" }
        if (@($stopCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne 1) { throw "duplicate managed Stop hook after Repair: $path" }
        if (@($preCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "custom PreToolUse hook was not preserved: $path" }
        if (@($stopCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "custom Stop hook was not preserved: $path" }
    }
    $antigravityHooks = Get-Content -LiteralPath (Join-Path $gemini 'config\hooks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($antigravityHooks.PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' }).Count -ne 2) { throw 'Antigravity managed hooks were duplicated after Repair' }
    if (-not $antigravityHooks.PSObject.Properties['user-custom']) { throw 'Antigravity custom top-level hook was not preserved' }

    New-Item -ItemType Directory -Force -Path (Join-Path $state 'projects\keep') | Out-Null
    Set-Content -LiteralPath (Join-Path $state 'projects\keep\task.md') -Value 'keep' -Encoding UTF8
    & (Join-Path $root 'install.ps1') -Action Uninstall -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -LegacyRoot $legacy
    if (-not (Test-Path -LiteralPath (Join-Path $state 'projects\keep\task.md'))) { throw 'uninstall deleted user data' }
    foreach ($path in @((Join-Path $claude 'settings.json'),(Join-Path $codex 'hooks.json'))) {
        $hookConfig = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-NoNullHooks $hookConfig $path
        $preCommands = Get-HookCommands $hookConfig 'PreToolUse'
        $stopCommands = Get-HookCommands $hookConfig 'Stop'
        if (@($preCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "uninstall removed custom PreToolUse hook: $path" }
        if (@($stopCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "uninstall removed custom Stop hook: $path" }
        if (@($preCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne 0) { throw "uninstall retained managed PreToolUse hook: $path" }
        if (@($stopCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne 0) { throw "uninstall retained managed Stop hook: $path" }
        if (@($hookConfig.hooks.PreToolUse).Count -ne 1) { throw "unexpected PreToolUse wrapper count after Uninstall: $path" }
        if (@($hookConfig.hooks.Stop).Count -ne 1) { throw "unexpected Stop wrapper count after Uninstall: $path" }
    }
    $antigravityHooks = Get-Content -LiteralPath (Join-Path $gemini 'config\hooks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $antigravityHooks.PSObject.Properties['user-custom']) { throw 'uninstall removed Antigravity custom top-level hook' }
    if (@($antigravityHooks.PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' }).Count -ne 0) { throw 'uninstall retained Antigravity managed hooks' }
    Write-Output 'installer tests passed'
} finally {
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
