# agent-workflow v4 - PreToolUse git safety guard.
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Read-HookInput {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
try {
    $raw = Read-HookInput
    $payload = $raw | ConvertFrom-Json
    $isAntigravity = $null -ne $payload.toolCall
    $cmd = if ($isAntigravity) {
        $toolArgs = $payload.toolCall.args
        # Antigravity run_command uses PascalCase CommandLine; keep command as a fallback.
        if ($toolArgs) { @($toolArgs.CommandLine, $toolArgs.command) | Where-Object { $_ } | Select-Object -First 1 }
    } else { $payload.tool_input.command }
    if (-not $cmd) { exit 0 }

    $flat = ($cmd -replace '\s+', ' ')
    if ($flat -notmatch '\bgit\b') { exit 0 }

    $denyPatterns = @(
        '\bgit\b[^&;|]*\bpush\b[^&;|]*(\s-f\b|\s--force\b|\s--force-with-lease\b)',
        '\bgit\b[^&;|]*\breset\b[^&;|]*\s--hard\b',
        '\bgit\b[^&;|]*\bclean\b[^&;|]*\s-[a-zA-Z]*f',
        '\bgit\b[^&;|]*\bbranch\b[^&;|]*\s-D\b',
        '\bgit\b[^&;|]*\bcheckout\b[^&;|]*\s--\s',
        '\bgit\b[^&;|]*\brestore\b(?![^&;|]*--staged)',
        '\bgit\b[^&;|]*\bstash\b[^&;|]*\b(drop|clear)\b'
    )
    foreach ($pattern in $denyPatterns) {
        if ($flat -match $pattern) {
            $reason = 'git-guard: destructive Git operation denied; ask the user to perform it explicitly.'
            $out = if ($isAntigravity) { @{ decision = 'deny'; reason = $reason } } else { @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } }
            Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
            exit 0
        }
    }

    $askPatterns = @(
        '\bgit\b[^&;|]*\bcommit\b', '\bgit\b[^&;|]*\bpush\b', '\bgit\b[^&;|]*\brebase\b',
        '\bgit\b[^&;|]*\bmerge\b(?![^&;|]*--abort)', '\bgit\b[^&;|]*\breset\b',
        '\bgit\b[^&;|]*\bcherry-pick\b', '\bgit\b[^&;|]*\brevert\b(?![^&;|]*--abort)'
    )
    foreach ($pattern in $askPatterns) {
        if ($flat -match $pattern) {
            $reason = 'git-guard: Git write requires explicit user approval.'
            $out = if ($isAntigravity) { @{ decision = 'ask'; reason = $reason } } else { @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = $reason } } }
            Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
            exit 0
        }
    }
} catch { }
exit 0
