# agent-workflow v4 - PreToolUse git safety guard.
#
# -Platform is supplied by the adapter's own hooks.json/hooks command line, not sniffed from the
# payload: Codex's PreToolUse wire shape intentionally mirrors Claude's (same tool_name/tool_input
# convention, confirmed against Codex's own hook schema), so there is no reliable field to tell
# the two apart from JSON alone. The adapter that invokes this script already knows which
# platform it is - adapters/codex/hooks.json passes -Platform Codex explicitly.
[CmdletBinding()]
param(
    [ValidateSet('', 'Claude', 'Codex', 'Antigravity')]
    [string]$Platform = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Read-HookInput {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

# --- read-only allowlist -----------------------------------------------------
# Fixed command shapes, not just subcommand names: an option can turn a "read" subcommand
# into a write (`git diff --output x`) or into arbitrary execution (`git -c core.pager=...`).
# Unknown options/arguments are rejected rather than guessed at (fail closed).

# PowerShell's -eq/-contains/switch are case-INSENSITIVE by default. That is dangerous here:
# it would let `-c` (arbitrary config injection, e.g. `-c core.pager=...`) match the `-C
# <path>` global-option check meant only for uppercase -C, silently reclassifying an injection
# as an allowlisted read. Every comparison in the read-only matcher below is case-sensitive
# (-ceq / -cnotcontains / -CaseSensitive) for that reason - this is a fail-closed allowlist,
# not a convenience matcher.

function Test-RevisionArg([string]$Token) {
    return ($Token -ceq 'HEAD') -or ($Token -cmatch '^HEAD~[1-9][0-9]*$') -or ($Token -cmatch '^[0-9a-fA-F]{7,40}$')
}

function Test-GitSegmentReadOnly([string[]]$Tokens) {
    if ($Tokens.Count -eq 0 -or $Tokens[0] -cne 'git') { return $false }
    $i = 1
    while ($i -lt $Tokens.Count) {
        if ($Tokens[$i] -ceq '-C') {
            if ($i + 1 -ge $Tokens.Count) { return $false }
            $i += 2; continue
        }
        if ($Tokens[$i] -ceq '--no-pager') { $i += 1; continue }
        break
    }
    if ($i -ge $Tokens.Count) { return $false }
    $subcommand = $Tokens[$i]
    # PowerShell's a..b range counts DOWN when a > b instead of producing an empty sequence,
    # so a naive ($i+1)..($Tokens.Count-1) slice returns bogus out-of-range elements once the
    # subcommand is the last token (e.g. plain `git status` with nothing to allowlist-check).
    $rest = if ($i + 1 -le $Tokens.Count - 1) { @($Tokens[($i + 1)..($Tokens.Count - 1)]) } else { @() }

    switch -CaseSensitive ($subcommand) {
        'status' {
            foreach ($t in $rest) { if (@('--short', '--porcelain', '--branch') -cnotcontains $t) { return $false } }
            return $true
        }
        'diff' {
            $afterDashDash = $false
            foreach ($t in $rest) {
                if ($afterDashDash) { continue }
                if ($t -ceq '--') { $afterDashDash = $true; continue }
                if (@('--binary', '--check', '--name-only', '--name-status') -ccontains $t) { continue }
                if (Test-RevisionArg $t) { continue }
                return $false
            }
            return $true
        }
        'log' {
            $afterDashDash = $false
            for ($j = 0; $j -lt $rest.Count; $j++) {
                if ($afterDashDash) { continue }
                $t = $rest[$j]
                if ($t -ceq '--') { $afterDashDash = $true; continue }
                if ($t -ceq '-n') {
                    if ($j + 1 -ge $rest.Count -or $rest[$j + 1] -notmatch '^[1-9][0-9]*$') { return $false }
                    $j++; continue
                }
                if ($t -ceq '--oneline') { continue }
                if (Test-RevisionArg $t) { continue }
                return $false
            }
            return $true
        }
        'rev-parse' {
            foreach ($t in $rest) {
                if (@('HEAD', '--is-inside-work-tree', '--show-toplevel', '--git-dir', '--git-common-dir') -cnotcontains $t) { return $false }
            }
            return $true
        }
        'ls-files' {
            $afterDashDash = $false
            foreach ($t in $rest) {
                if ($afterDashDash) { continue }
                if ($t -ceq '--') { $afterDashDash = $true; continue }
                if (@('--others', '--exclude-standard', '-z') -cnotcontains $t) { return $false }
            }
            return $true
        }
        default { return $false }
    }
}

function Test-ReadOnlyGitCommand([string]$Command) {
    if ($Command -match '\|') { return $false }
    $segments = @($Command -split '(?:;|&&)' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($segments.Count -eq 0) { return $false }
    foreach ($segment in $segments) {
        $tokens = @($segment -split '\s+' | Where-Object { $_ })
        if (-not (Test-GitSegmentReadOnly $tokens)) { return $false }
    }
    return $true
}

# --- role -------------------------------------------------------------------

# Shared by every decision point below (worker/coordinator hard denies, the pattern-based
# deny/ask lists). Antigravity uses a flat {decision, reason}; Claude and Codex use the nested
# hookSpecificOutput.permissionDecision shape - both confirmed against their respective hook
# schemas. Writes and exits, matching every call site this replaces.
function Write-Decision([string]$Decision, [string]$Reason, [bool]$IsAntigravity) {
    $out = if ($IsAntigravity) {
        @{ decision = $Decision; reason = $Reason }
    } else {
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = $Decision; permissionDecisionReason = $Reason } }
    }
    Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
    exit 0
}

function Get-ActiveSubtaskRole([string]$Cwd) {
    $resolver = Join-Path $PSScriptRoot '..\scripts\project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolver)) { return '' }
    $resolved = (& $resolver -Path $Cwd | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -ne 1 -or -not (Test-Path -LiteralPath $active[0])) { return '' }
    $content = Get-Content -LiteralPath $active[0] -Raw -Encoding UTF8
    if ($content -match '(?m)^subtask_role:[ \t]*(\S+)') { return $Matches[1] }
    return ''
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

    $flat = ($cmd -replace '\s+', ' ').Trim()
    if ($flat -notmatch '\bgit\b') { exit 0 }

    # Cheapest possible exit: a command built entirely of allowlisted read-only Git invocations
    # is safe for every role and never needs a project resolve. This keeps the highest-frequency
    # commands (git status, git diff) free of resolver cost, matching impact-guard's convention
    # of running the expensive check last.
    if (Test-ReadOnlyGitCommand $flat) { exit 0 }

    $cwd = if ($payload.workspacePaths) { @($payload.workspacePaths)[0] } else { $payload.cwd }
    $role = if ($cwd) { Get-ActiveSubtaskRole $cwd } else { '' }

    if ($role -eq 'worker') {
        # Already confirmed not fully read-only above; a worker gets nothing else - not `git
        # add`, not `git branch`, not `git config --local`. Deny, not ask: in a subagent there
        # may be nobody to answer an approval prompt.
        Write-Decision 'deny' 'git-guard: worker task may only run allowlisted read-only Git commands.' $isAntigravity
    }
    if ($role -eq 'coordinator') {
        # The only sanctioned writer of the main working tree is orchestrate.ps1; any direct
        # Git write (apply, worktree, add, restore, reset, ...) is denied, not just the ones
        # that happen to be named here.
        Write-Decision 'deny' 'git-guard: coordinator task must not run direct Git writes; use orchestrate.ps1.' $isAntigravity
    }

    # Plain task (or no resolvable role): unchanged pattern-based behaviour.
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
            Write-Decision 'deny' 'git-guard: destructive Git operation denied; ask the user to perform it explicitly.' $isAntigravity
        }
    }

    $askPatterns = @(
        '\bgit\b[^&;|]*\bcommit\b', '\bgit\b[^&;|]*\bpush\b', '\bgit\b[^&;|]*\brebase\b',
        '\bgit\b[^&;|]*\bmerge\b(?![^&;|]*--abort)', '\bgit\b[^&;|]*\breset\b',
        '\bgit\b[^&;|]*\bcherry-pick\b', '\bgit\b[^&;|]*\brevert\b(?![^&;|]*--abort)'
    )
    foreach ($pattern in $askPatterns) {
        if ($flat -match $pattern) {
            if ($Platform -eq 'Codex') {
                # Codex's own hook schema documents permissionDecision: "ask" as unsupported and
                # rejected - confirmed against codex-rs/hooks/src/schema.rs and the exit-code
                # handling in pre_tool_use.rs (an invalid decision falls into HookRunStatus::Failed,
                # which is not applied as a control effect, so the command runs unguarded). "ask"
                # is not a safe no-op on Codex; it is silent allow. Deny is the only machine-checked
                # option Codex actually honors for these commands.
                Write-Decision 'deny' 'git-guard: Codex does not support an interactive approval prompt for this hook, so the write is denied outright. Ask the user to run this Git command themselves.' $isAntigravity
            }
            Write-Decision 'ask' 'git-guard: Git write requires explicit user approval.' $isAntigravity
        }
    }
} catch {
    # Fail-open is deliberate, but a silent failure is indistinguishable from an allow: this hook
    # once ran 81 times and only succeeded 9, because a parse error looked exactly like a pass.
    # Record it, then release the command. runtime-check.ps1 surfaces the log.
    try {
        $logDir = Join-Path $env:USERPROFILE '.agent-workflow\logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        Add-Content -LiteralPath (Join-Path $logDir 'hook-errors.log') -Value ((Get-Date).ToString('s') + "`tgit-guard`t" + $_.Exception.Message) -Encoding UTF8
    } catch { }
}
exit 0
