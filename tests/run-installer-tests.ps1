$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repoSharedRoot = Join-Path $root '.agents'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-installer-' + [guid]::NewGuid().ToString('N'))
$claude = Join-Path $sandbox '.claude'
$codex = Join-Path $sandbox '.codex'
$gemini = Join-Path $sandbox '.gemini'
$state = Join-Path $sandbox '.agent-workflow'
$canonical = Join-Path $sandbox '.agents'
$legacy = Join-Path $sandbox '.agents'
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$managedHooksDir = Join-Path $state 'runtime\hooks'
$customCommand = 'powershell.exe -NoProfile -File "C:\custom\user-hook.ps1"'

function Write-TestJson([string]$Path, $Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

function Write-TestText([string]$Path, [string]$Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Value, $utf8NoBom)
}

function Assert-CanonicalLinks([string]$CanonicalPath, [string[]]$Paths) {
    $lists = @()
    foreach ($path in @($CanonicalPath) + @($Paths)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing canonical entrypoint: $path" }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($hash -ne (Get-FileHash -LiteralPath $CanonicalPath -Algorithm SHA256).Hash) { throw "canonical hash mismatch: $path" }
        $lists += ((& fsutil hardlink list $path 2>$null) -join "`n")
    }
    if (@($lists | Select-Object -Unique).Count -ne 1) { throw 'entrypoints do not share one hard-link identity' }
    if ((@(& fsutil hardlink list $CanonicalPath 2>$null)).Count -lt (@($Paths).Count + 1)) { throw 'canonical hard-link set is incomplete' }
}

function Assert-JunctionTo([string]$Path, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "missing skill junction: $Path" }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw "skill path is not a junction: $Path" }
    $targetNorm = [IO.Path]::GetFullPath($Target).TrimEnd('\','/').ToLowerInvariant()
    foreach ($candidate in @($item.Target)) {
        if ($candidate -and [IO.Path]::GetFullPath([string]$candidate).TrimEnd('\','/').ToLowerInvariant() -eq $targetNorm) { return }
    }
    throw "skill junction target mismatch: $Path"
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
    $sharedPrefix = '# shared user instructions'
    Write-TestText (Join-Path $claude 'CLAUDE.md') $sharedPrefix
    Write-TestText (Join-Path $codex 'AGENTS.md') $sharedPrefix
    Write-TestText (Join-Path $gemini 'GEMINI.md') $sharedPrefix

    & (Join-Path $root 'install.ps1') -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -CanonicalRoot $canonical -LegacyRoot $legacy
    if ($LASTEXITCODE) { throw 'installer failed' }
    Assert-CanonicalLinks (Join-Path $canonical 'AGENTS.md') @((Join-Path $claude 'CLAUDE.md'),(Join-Path $codex 'AGENTS.md'),(Join-Path $gemini 'GEMINI.md'))
    if (-not (Get-Content -LiteralPath (Join-Path $canonical 'AGENTS.md') -Raw -Encoding UTF8).Contains($sharedPrefix)) { throw 'shared unmanaged prefix was not preserved' }
    foreach ($relative in @('agents\reviewer.md','agents\verifier.md','skills\workflow\SKILL.md')) {
        $canonicalShared = Join-Path $canonical $relative
        $repoShared = Join-Path $repoSharedRoot $relative
        if (-not (Test-Path -LiteralPath $canonicalShared -PathType Leaf)) { throw "missing canonical shared file: $relative" }
        if ((Get-FileHash -LiteralPath $canonicalShared -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $repoShared -Algorithm SHA256).Hash) { throw "canonical shared file mismatch: $relative" }
    }
    Assert-CanonicalLinks (Join-Path $canonical 'skills\workflow\SKILL.md') @(
        (Join-Path $state 'runtime\skills\workflow\SKILL.md')
    )
    Assert-JunctionTo (Join-Path $claude 'skills\workflow') (Join-Path $canonical 'skills\workflow')
    Assert-JunctionTo (Join-Path $codex 'skills\workflow') (Join-Path $canonical 'skills\workflow')
    Assert-JunctionTo (Join-Path $gemini 'config\skills\workflow') (Join-Path $canonical 'skills\workflow')
    Assert-CanonicalLinks (Join-Path $canonical 'agents\reviewer.md') @((Join-Path $state 'runtime\agents\reviewer.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\claude\agent-workflow-reviewer.md') @((Join-Path $claude 'agents\agent-workflow-reviewer.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\antigravity\agent-workflow-reviewer.md') @((Join-Path $gemini 'config\agents\agent-workflow-reviewer\agent.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\codex\agent-workflow-reviewer.toml') @((Join-Path $codex 'agents\agent-workflow-reviewer.toml'))
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
        & (Join-Path $root 'install.ps1') -Action $action -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -CanonicalRoot $canonical -LegacyRoot $legacy
        if ($LASTEXITCODE) { throw "installer $action failed" }
        Assert-CanonicalLinks (Join-Path $canonical 'AGENTS.md') @((Join-Path $claude 'CLAUDE.md'),(Join-Path $codex 'AGENTS.md'),(Join-Path $gemini 'GEMINI.md'))
        Assert-CanonicalLinks (Join-Path $canonical 'skills\workflow\SKILL.md') @((Join-Path $state 'runtime\skills\workflow\SKILL.md'))
        Assert-JunctionTo (Join-Path $claude 'skills\workflow') (Join-Path $canonical 'skills\workflow')
        Assert-JunctionTo (Join-Path $codex 'skills\workflow') (Join-Path $canonical 'skills\workflow')
        Assert-JunctionTo (Join-Path $gemini 'config\skills\workflow') (Join-Path $canonical 'skills\workflow')
        Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\codex\agent-workflow-reviewer.toml') @((Join-Path $codex 'agents\agent-workflow-reviewer.toml'))
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
    & (Join-Path $root 'install.ps1') -Action Uninstall -TargetAgent All -ClaudeTarget $claude -CodexTarget $codex -AntigravityTarget $gemini -StateRoot $state -CanonicalRoot $canonical -LegacyRoot $legacy
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

    if (-not (Test-Path -LiteralPath (Join-Path $canonical 'AGENTS.md'))) { throw 'uninstall removed canonical user entrypoint' }
    if (-not (Get-Content -LiteralPath (Join-Path $canonical 'AGENTS.md') -Raw -Encoding UTF8).Contains($sharedPrefix)) { throw 'uninstall removed canonical user content' }
    Assert-CanonicalLinks (Join-Path $canonical 'AGENTS.md') @((Join-Path $claude 'CLAUDE.md'),(Join-Path $codex 'AGENTS.md'),(Join-Path $gemini 'GEMINI.md'))
    foreach ($relative in @('agents\reviewer.md','agents\verifier.md','skills\workflow\SKILL.md','agents\platforms\codex\agent-workflow-reviewer.toml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $canonical $relative) -PathType Leaf)) { throw "uninstall removed canonical shared source: $relative" }
    }
    foreach ($path in @((Join-Path $claude 'skills\workflow'),(Join-Path $codex 'skills\workflow'),(Join-Path $gemini 'config\skills\workflow'))) {
        if (Test-Path -LiteralPath $path) { throw "uninstall retained managed skill junction: $path" }
    }

    $conflictSandbox = Join-Path $sandbox 'conflict'
    $conflictClaude = Join-Path $conflictSandbox '.claude'
    $conflictCodex = Join-Path $conflictSandbox '.codex'
    $conflictGemini = Join-Path $conflictSandbox '.gemini'
    $conflictState = Join-Path $conflictSandbox '.agent-workflow'
    $conflictCanonical = Join-Path $conflictSandbox '.agents'
    Write-TestText (Join-Path $conflictClaude 'CLAUDE.md') '# claude-only'
    Write-TestText (Join-Path $conflictCodex 'AGENTS.md') '# codex-only'
    Write-TestText (Join-Path $conflictGemini 'GEMINI.md') '# gemini-only'
    $conflictFailed = $false
    $conflictOutput = ''
    try {
        $conflictOutput = & (Join-Path $root 'install.ps1') -TargetAgent All -ClaudeTarget $conflictClaude -CodexTarget $conflictCodex -AntigravityTarget $conflictGemini -StateRoot $conflictState -CanonicalRoot $conflictCanonical -LegacyRoot $conflictCanonical 2>&1 | Out-String
    } catch {
        $conflictFailed = $true
        $conflictOutput = $_.Exception.Message
    }
    if (-not $conflictFailed -or $conflictOutput -notmatch 'Conflicting unmanaged entrypoint content') { throw 'conflicting entrypoint content was not blocked' }
    if (Test-Path -LiteralPath (Join-Path $conflictCanonical 'AGENTS.md')) { throw 'conflicting migration wrote a canonical file' }
    if (@(Get-ChildItem -LiteralPath $conflictSandbox -Recurse -File -Filter '*.bak.*' -ErrorAction SilentlyContinue).Count -lt 3) { throw 'conflicting migration did not create timestamp backups' }
    Write-Output 'installer tests passed'
} finally {
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
