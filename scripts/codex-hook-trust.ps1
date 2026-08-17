# agent-workflow v4 - shared logic for reading Codex's per-hook trust state.
#
# Codex trusts each hook entry individually via config.toml keys shaped
# "<hooks.json path>:<event snake_case>:<matcher index>:<hook index>" (confirmed against
# codex-rs/config/src/hooks_tests.rs). install.ps1 (to warn right after writing hooks.json) and
# runtime-check.ps1 (to warn on every later health check) both need this, and used to carry two
# independent copies of the same event-name map, TOML-key regex and key-computation loop - the
# exact kind of drift risk this repo's own path-grammar.ps1 was extracted to avoid elsewhere.
#
# Dot-sourced, not invoked as `& codex-hook-trust.ps1` - see path-grammar.ps1 for why.

function Get-CodexEventSnakeCaseMap {
    return @{ PreToolUse = 'pre_tool_use'; PostToolUse = 'post_tool_use'; Stop = 'stop'; SessionStart = 'session_start'; SessionEnd = 'session_end'; UserPromptSubmit = 'user_prompt_submit' }
}

function Get-CodexHookStateKeys([string]$ConfigPath) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return @() }
    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
    $keys = @()
    foreach ($match in [regex]::Matches($raw, "(?m)^\[hooks\.state\.'([^']+)'\]")) { $keys += $match.Groups[1].Value }
    foreach ($match in [regex]::Matches($raw, '(?m)^\[hooks\.state\."([^"]+)"\]')) { $keys += $match.Groups[1].Value }
    return $keys
}

# $IsManagedCommand decides which hook entries the caller cares about. install.ps1 and
# runtime-check.ps1 have different definitions of "managed" (install.ps1's own
# Test-ManagedHookCommand also matches legacy v3 markers, for removal purposes;
# runtime-check.ps1 only cares whether a command points at the current v4 hooks dir), so that
# decision stays with the caller rather than being hard-coded here.
function Get-UntrustedCodexHookKeys([string]$HooksJsonPath, [string]$ConfigPath, [scriptblock]$IsManagedCommand) {
    if (-not (Test-Path -LiteralPath $HooksJsonPath -PathType Leaf)) { return @() }
    $data = $null
    try { $data = Get-Content -LiteralPath $HooksJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return @() }
    if (-not $data -or -not $data.PSObject.Properties['hooks']) { return @() }
    $trustedKeys = @(Get-CodexHookStateKeys $ConfigPath)
    $eventSnakeCase = Get-CodexEventSnakeCaseMap
    $missing = @()
    foreach ($event in $data.hooks.PSObject.Properties) {
        $snake = if ($eventSnakeCase.ContainsKey($event.Name)) { $eventSnakeCase[$event.Name] } else { $event.Name.ToLowerInvariant() }
        $matcherGroups = @($event.Value)
        for ($matcherIdx = 0; $matcherIdx -lt $matcherGroups.Count; $matcherIdx++) {
            $hookList = @($matcherGroups[$matcherIdx].hooks)
            for ($hookIdx = 0; $hookIdx -lt $hookList.Count; $hookIdx++) {
                $command = [string]$hookList[$hookIdx].command
                if (-not $command -or -not (& $IsManagedCommand $command)) { continue }
                $key = "${HooksJsonPath}:${snake}:${matcherIdx}:${hookIdx}"
                if ($trustedKeys -notcontains $key) { $missing += $key }
            }
        }
    }
    return $missing
}
