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

# v3 shipped its own hooks under "<platform-root>\hooks\ai-workflow\...", registered on event
# types v4 never defines anything for (Codex: PostToolUse/SessionEnd; Claude: PostToolUse/
# SessionEnd too). $legacyCommand simulates that: a real profile still had it after several
# Repairs, because Merge-Hooks used to only sweep events present in the incoming v4 fragment
# (PreToolUse/Stop) and never even looked at SessionEnd's array.
function Write-MixedHookFixture([string]$Path, [string]$Matcher) {
    $legacyCommand = 'powershell.exe -NoProfile -File "C:\legacy-profile\hooks\ai-workflow\log-session.ps1"'
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
            SessionEnd = @([ordered]@{ hooks=@(
                [ordered]@{ type='command'; command=$customCommand; timeout=5 },
                [ordered]@{ type='command'; command=$legacyCommand; timeout=15 }
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
    foreach ($relative in @('agents\reviewer.md','agents\adversarial.md','agents\verifier.md','agents\retrospective.md','agents\worker.md','skills\workflow\SKILL.md','skills\workflow\risk-flags.md','skills\workflow\orchestration.md')) {
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
    # retrospective is a review-side role like reviewer/adversarial/verifier, so unlike worker it
    # ships to all three platforms.
    Assert-CanonicalLinks (Join-Path $canonical 'agents\retrospective.md') @((Join-Path $state 'runtime\agents\retrospective.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\claude\agent-workflow-retrospective.md') @((Join-Path $claude 'agents\agent-workflow-retrospective.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\codex\agent-workflow-retrospective.toml') @((Join-Path $codex 'agents\agent-workflow-retrospective.toml'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\antigravity\agent-workflow-retrospective.md') @((Join-Path $gemini 'config\agents\agent-workflow-retrospective\agent.md'))
    # worker is Claude-only in v1 (Codex/Antigravity fan-out is unverified) - only the Claude
    # adapter should exist for it, and its canonical hardlink identity must match reviewer's.
    Assert-CanonicalLinks (Join-Path $canonical 'agents\worker.md') @((Join-Path $state 'runtime\agents\worker.md'))
    Assert-CanonicalLinks (Join-Path $canonical 'agents\platforms\claude\agent-workflow-worker.md') @((Join-Path $claude 'agents\agent-workflow-worker.md'))
    if (Test-Path -LiteralPath (Join-Path $codex 'agents\agent-workflow-worker.toml')) { throw 'worker adapter must not be generated for Codex in v1' }
    if (Test-Path -LiteralPath (Join-Path $gemini 'config\agents\agent-workflow-worker')) { throw 'worker adapter must not be generated for Antigravity in v1' }
    foreach ($path in @(
        (Join-Path $claude 'agents\agent-workflow-reviewer.md'),
        (Join-Path $claude 'agents\agent-workflow-worker.md'),
        (Join-Path $codex 'agents\agent-workflow-reviewer.toml'),
        (Join-Path $gemini 'config\agents\agent-workflow-reviewer\agent.md'),
        (Join-Path $state 'runtime\hooks\quality-gate.ps1'),
        (Join-Path $state 'runtime\scripts\pre-review.ps1'),
        (Join-Path $state 'runtime\scripts\project-resolver.ps1')
    )) { if (-not (Test-Path -LiteralPath $path)) { throw "missing installed file: $path" } }
    $installedPreReview = Join-Path $state 'runtime\scripts\pre-review.ps1'
    $preReviewOutput = & $hostExe -NoProfile -ExecutionPolicy Bypass -File $installedPreReview -RepoRoot $sandbox | Out-String
    if ($LASTEXITCODE -ne 0 -or $preReviewOutput -notmatch 'RESULT: SKIP') { throw 'installed pre-review runtime is not executable' }
    $installedSchema = Get-Content -LiteralPath (Join-Path $state 'runtime\schemas\task.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($installedSchema.required) -notcontains 'code_change' -or $installedSchema.properties.code_change.type -ne 'boolean') { throw 'installed task schema is missing code_change' }
    $installedWorkflow = Get-Content -LiteralPath (Join-Path $state 'runtime\skills\workflow\SKILL.md') -Raw -Encoding UTF8
    if ($installedWorkflow -notmatch 'code_change: true' -or $installedWorkflow -notmatch 'code_change: false') { throw 'installed workflow is missing code_change role rules' }
    $installedCodexHooks = Get-Content -LiteralPath (Join-Path $codex 'hooks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($eventName in @('PreToolUse','Stop')) {
        foreach ($wrapper in @($installedCodexHooks.hooks.$eventName)) {
            foreach ($hook in @($wrapper.hooks)) {
                if ($hook.command -and $hook.command.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $hook.PSObject.Properties['timeout']) {
                    throw "installed Codex managed $eventName hook still has a fixed timeout"
                }
            }
        }
    }
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
    # Expected managed counts come from the adapter itself, so adding a hook does not need a test edit.
    foreach ($pair in @(
        @{ path = (Join-Path $claude 'settings.json'); adapter = (Join-Path $root 'adapters\claude\settings.hooks.json') },
        @{ path = (Join-Path $codex 'hooks.json'); adapter = (Join-Path $root 'adapters\codex\hooks.json') }
    )) {
        $path = $pair.path
        $adapterHooks = (Get-Content -LiteralPath $pair.adapter -Raw -Encoding UTF8 | ConvertFrom-Json).hooks
        $expectedPre = @($adapterHooks.PreToolUse | Where-Object { $null -ne $_ }).Count
        $expectedStop = @($adapterHooks.Stop | Where-Object { $null -ne $_ }).Count
        $hookConfig = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-NoNullHooks $hookConfig $path
        $preCommands = Get-HookCommands $hookConfig 'PreToolUse'
        $stopCommands = Get-HookCommands $hookConfig 'Stop'
        if (@($hookConfig.hooks.PreToolUse).Count -ne ($expectedPre + 1)) { throw "unexpected PreToolUse wrapper count after Repair: $path" }
        if (@($hookConfig.hooks.Stop).Count -ne ($expectedStop + 1)) { throw "unexpected Stop wrapper count after Repair: $path" }
        if (@($preCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne $expectedPre) { throw "duplicate managed PreToolUse hook after Repair: $path" }
        if (@($stopCommands | Where-Object { $_.IndexOf($managedHooksDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -ne $expectedStop) { throw "duplicate managed Stop hook after Repair: $path" }
        if (@($preCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "custom PreToolUse hook was not preserved: $path" }
        if (@($stopCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "custom Stop hook was not preserved: $path" }
        # Regression check for the gap a real profile hit: Merge-Hooks used to only sweep events
        # present in the incoming v4 fragment, so a v3 leftover under an event v4 never defines
        # (SessionEnd) was never even visited and survived every Repair. It must be gone now,
        # while a genuinely unrelated custom SessionEnd hook is left alone.
        $sessionEndCommands = Get-HookCommands $hookConfig 'SessionEnd'
        if (@($sessionEndCommands | Where-Object { $_ -match '\\hooks\\ai-workflow\\' }).Count -ne 0) { throw "legacy v3 SessionEnd hook survived Repair (event outside the v4 fragment was never swept): $path" }
        if (@($sessionEndCommands | Where-Object { $_ -eq $customCommand }).Count -ne 1) { throw "custom SessionEnd hook was not preserved: $path" }
    }
    $antigravityHooks = Get-Content -LiteralPath (Join-Path $gemini 'config\hooks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedAntigravity = @((Get-Content -LiteralPath (Join-Path $root 'adapters\antigravity\hooks.json') -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' }).Count
    if (@($antigravityHooks.PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' }).Count -ne $expectedAntigravity) { throw 'Antigravity managed hooks were duplicated after Repair' }
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

    # Test-LegacyKnowledge: a v3 signal path must refuse Install before touching anything, but a
    # machine that only ever had ordinary native Claude/Codex memory (no v3 marker string) must be
    # let through. Each case gets its own fresh sandbox (no activation.json) since the check
    # short-circuits to "already installed" once one exists.
    $legacySandbox = Join-Path $sandbox 'legacy-signal'
    $legacyClaude = Join-Path $legacySandbox '.claude'
    $legacyCodex = Join-Path $legacySandbox '.codex'
    $legacyGemini = Join-Path $legacySandbox '.gemini'
    $legacyState = Join-Path $legacySandbox '.agent-workflow'
    $legacyCanonical = Join-Path $legacySandbox '.agents'
    Write-TestText (Join-Path $legacyCodex 'agent-workflow\marker.txt') 'v3 runtime leftover'
    $legacyFailed = $false
    $legacyOutput = ''
    try {
        $legacyOutput = & (Join-Path $root 'install.ps1') -TargetAgent All -ClaudeTarget $legacyClaude -CodexTarget $legacyCodex -AntigravityTarget $legacyGemini -StateRoot $legacyState -CanonicalRoot $legacyCanonical -LegacyRoot $legacyCanonical 2>&1 | Out-String
    } catch {
        $legacyFailed = $true
        $legacyOutput = $_.Exception.Message
    }
    if (-not $legacyFailed -or $legacyOutput -notmatch 'v3 knowledge or history was found') { throw "a v3 signal path (.codex\agent-workflow) did not block Install: $legacyOutput" }

    $nativeSandbox = Join-Path $sandbox 'native-only'
    $nativeClaude = Join-Path $nativeSandbox '.claude'
    $nativeCodex = Join-Path $nativeSandbox '.codex'
    $nativeGemini = Join-Path $nativeSandbox '.gemini'
    $nativeState = Join-Path $nativeSandbox '.agent-workflow'
    $nativeCanonical = Join-Path $nativeSandbox '.agents'
    Write-TestText (Join-Path $nativeClaude 'projects\some-project\memory\note.md') '# ordinary native Claude memory, unrelated to this framework'
    $nativeFailed = $false
    $nativeOutput = ''
    try {
        $nativeOutput = & (Join-Path $root 'install.ps1') -TargetAgent All -ClaudeTarget $nativeClaude -CodexTarget $nativeCodex -AntigravityTarget $nativeGemini -StateRoot $nativeState -CanonicalRoot $nativeCanonical -LegacyRoot $nativeCanonical 2>&1 | Out-String
    } catch {
        $nativeFailed = $true
        $nativeOutput = $_.Exception.Message
    }
    if ($nativeFailed -and $nativeOutput -match 'v3 knowledge or history was found') { throw "plain native Claude memory with no v3 marker was refused: $nativeOutput" }
    if ($nativeFailed) { throw "native-memory-only Install failed for an unrelated reason: $nativeOutput" }
    if (-not (Test-Path -LiteralPath (Join-Path $nativeState 'managed-runtime.json'))) { throw "native-memory-only Install did not proceed past Test-LegacyKnowledge: $nativeOutput" }

    Write-Output 'installer tests passed'
} finally {
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
