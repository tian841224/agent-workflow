# agent-workflow v4 - PreToolUse guard: require the task impact surface before editing code.
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Read-HookInput {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-Section([string]$Content, [string]$Prefix) {
    $escaped = [regex]::Escape($Prefix)
    return [regex]::Match($Content, "(?ms)^## $escaped.*?\r?\n(.*?)(?=^## |\z)").Groups[1].Value.Trim()
}

function Resolve-FullPath([string]$Path) {
    try { return [IO.Path]::GetFullPath($Path) } catch { return $Path }
}

function Write-Deny([string]$Reason, [bool]$IsAntigravity) {
    $out = if ($IsAntigravity) { @{ decision = 'deny'; reason = $Reason } } else { @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $Reason } } }
    Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
    exit 0
}

# Plain StartsWith has no separator boundary: "C:\repo" would prefix-match "C:\repo-backup\x",
# and a task dir ending in "...-orch" would prefix-match a sibling "...-orchestra\task.md". Both
# sides must line up on a directory boundary, not just share a character prefix.
function Test-PathWithin([string]$Target, [string]$Root) {
    if ($Target.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return $Target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

# Everything the caller is about to write, across the three platform payload shapes. Only used
# to spot a direct `status: done`, so over-collecting is harmless - a field that is not part of
# the write simply never contains that line.
function Get-WriteText($Payload, [bool]$IsAntigravity) {
    $parts = @()
    if ($IsAntigravity) {
        $toolArgs = $Payload.toolCall.args
        if ($toolArgs) {
            foreach ($key in @('CodeEdit','ReplacementText','Content','content','NewString','new_string')) {
                if ($toolArgs.PSObject.Properties[$key] -and $toolArgs.$key -is [string]) { $parts += [string]$toolArgs.$key }
            }
        }
    } else {
        $toolInput = $Payload.tool_input
        if ($toolInput -is [string]) { $parts += $toolInput }
        elseif ($toolInput) {
            foreach ($key in @('content','new_string','new_str','input')) {
                if ($toolInput.PSObject.Properties[$key] -and $toolInput.$key -is [string]) { $parts += [string]$toolInput.$key }
            }
            if ($toolInput.PSObject.Properties['edits']) {
                foreach ($edit in @($toolInput.edits)) {
                    if ($edit.new_string -is [string]) { $parts += [string]$edit.new_string }
                }
            }
        }
    }
    return ($parts -join "`n")
}

# Codex apply_patch is freeform: the paths only exist in the patch headers.
function Get-PatchPath([string]$Text) {
    $found = @()
    foreach ($match in [regex]::Matches($Text, '(?m)^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$')) { $found += $match.Groups[1].Value }
    foreach ($match in [regex]::Matches($Text, '(?m)^\*\*\*\s+Move to:\s*(.+?)\s*$')) { $found += $match.Groups[1].Value }
    return $found
}

try {
    $raw = Read-HookInput
    $payload = $raw | ConvertFrom-Json
    $isAntigravity = $null -ne $payload.toolCall

    # Every early exit below releases the edit; the expensive project resolve runs last.
    $cwd = if ($payload.workspacePaths) { @($payload.workspacePaths)[0] } else { $payload.cwd }
    if (-not $cwd) { exit 0 }
    $cwd = Resolve-FullPath $cwd

    $targets = @()
    if ($isAntigravity) {
        $toolArgs = $payload.toolCall.args
        if ($toolArgs) {
            foreach ($key in @('TargetFile','AbsolutePath','file_path','path')) {
                if ($toolArgs.PSObject.Properties[$key] -and $toolArgs.$key) { $targets += [string]$toolArgs.$key; break }
            }
        }
    } else {
        $toolInput = $payload.tool_input
        if ($toolInput -is [string]) { $targets += Get-PatchPath $toolInput }
        elseif ($toolInput) {
            if ($toolInput.file_path) { $targets += [string]$toolInput.file_path }
            elseif ($toolInput.input -is [string]) { $targets += Get-PatchPath ([string]$toolInput.input) }
        }
    }
    if (-not $targets) { exit 0 }

    # Split candidates into "inside cwd" (subject to the code-change/impact-surface gate, and
    # to the coordinator hard-deny) and "inside state root but outside cwd" (normally just the
    # task file itself, but for coordinator/worker roles must be narrowed to that role's own
    # task directory). Anything outside both is out of scope, same as before role-awareness
    # existed. cwd must be checked BEFORE state root: a worker's own worktree is created under
    # ~/.agent-workflow/projects/<pid>/worktrees/<id>/ by orchestrate.ps1, so cwd itself is
    # nested inside state root - checking state root first would misclassify every in-worktree
    # edit as a state-root target and it would never reach the normal code_change gate.
    $stateRoot = Resolve-FullPath (Join-Path $env:USERPROFILE '.agent-workflow')
    $gated = @()
    $stateRootTargets = @()
    foreach ($candidate in $targets) {
        $full = if ([IO.Path]::IsPathRooted($candidate)) { Resolve-FullPath $candidate } else { Resolve-FullPath (Join-Path $cwd $candidate) }
        if (Test-PathWithin $full $cwd) { $gated += $full; continue }
        if (Test-PathWithin $full $stateRoot) { $stateRootTargets += $full; continue }
    }
    if (-not $gated -and -not $stateRootTargets) { exit 0 }

    # `status: done` is the one task edit no gate used to inspect: the Stop hook only resolves
    # in_progress tasks, so flipping the field to done made the task invisible to it. Tasks have
    # shipped that way with every completion criterion unticked and placeholder validation
    # results. Deny the direct write and route it through close-task.ps1, which re-runs the whole
    # gate first. Checked before the project resolve so it also covers a task whose worktree no
    # longer has an active task, and so it costs nothing on ordinary edits.
    $taskFileTargets = @(@($gated) + @($stateRootTargets) | Where-Object { [IO.Path]::GetFileName($_) -eq 'task.md' })
    if ($taskFileTargets) {
        $writeText = Get-WriteText $payload $isAntigravity
        # \+? because a Codex apply_patch body carries the new line as "+status: done".
        if ($writeText -match '(?m)^[ \t]*\+?[ \t]*status:[ \t]*done[ \t]*\r?$') {
            Write-Deny "impact-guard: do not set 'status: done' by editing the task file. Run ~/.agent-workflow/runtime/scripts/close-task.ps1 instead - it re-runs the full completion gate (criteria, pre-review, Reviewer/Adversarial/Verifier, diff fingerprint) and only then writes done. Use paused or blocked if the work is stopping without finishing." $isAntigravity
        }
    }

    $resolver = Join-Path $PSScriptRoot '..\scripts\project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolver)) { exit 0 }
    $resolved = (& $resolver -Path $cwd | Out-String) | ConvertFrom-Json
    $active = @($resolved.active_tasks)
    if ($active.Count -ne 1) { exit 0 }

    $taskPath = $active[0]
    if (-not (Test-Path -LiteralPath $taskPath)) { exit 0 }
    $content = [regex]::Replace((Get-Content -LiteralPath $taskPath -Raw -Encoding UTF8), '(?s)<!--.*?-->', '')
    $role = if ($content -match '(?m)^subtask_role:[ \t]*(\S+)') { $Matches[1] } else { '' }
    $ownTaskDir = Resolve-FullPath (Split-Path -Parent $taskPath)

    $reason = ''

    if ($role -eq 'coordinator' -and $gated) {
        # Coordinators do not edit source: the sanctioned writer is `orchestrate.ps1 -Action Apply`.
        #
        # The single, deliberately narrow exception is hand-merging an apply conflict. Two workers
        # can legitimately need the same file, and the resolution is a human/coordinator merge -
        # there is no way to do that through git apply. Only integration_status: conflicted AND a
        # target listed in orchestration.json's conflicts[] unlocks anything; everything else still
        # denies, and once every conflict is resolved the list empties and the exception closes.
        #
        # This narrows WHAT gets edited, not WHO is trusted: both integration_status and
        # orchestration.json live inside the coordinator's own task directory, which the
        # coordinator can already write. A coordinator could self-declare a conflict to unlock a
        # path. That is consistent with this whole boundary being a collaborative guard rather
        # than a security one (see orchestration.md's known limitations) - not a gap unique to
        # this exception.
        $allowedPaths = @()
        if ($content -match '(?m)^integration_status:[ \t]*conflicted[ \t]*\r?$') {
            $orchestrationFile = Join-Path $ownTaskDir 'orchestration.json'
            if (Test-Path -LiteralPath $orchestrationFile) {
                $orchestration = Get-Content -LiteralPath $orchestrationFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $repoRoot = Resolve-FullPath $resolved.root
                foreach ($conflict in @($orchestration.conflicts)) {
                    foreach ($relative in @($conflict.paths)) {
                        if ($relative) { $allowedPaths += Resolve-FullPath (Join-Path $repoRoot ($relative -replace '/', '\')) }
                    }
                }
            }
        }
        $denied = @($gated | Where-Object { $path = $_; -not @($allowedPaths | Where-Object { $_.Equals($path, [StringComparison]::OrdinalIgnoreCase) }).Count })
        if ($denied) {
            $reason = if ($allowedPaths) {
                "impact-guard: coordinator task $taskPath may only edit the conflicting paths recorded in orchestration.json while resolving a merge; denied: $($denied -join ', ')"
            } else {
                "impact-guard: coordinator task $taskPath must not edit source directly; use orchestrate.ps1 -Action Apply."
            }
        }
    }

    if (-not $reason -and $stateRootTargets -and ($role -eq 'coordinator' -or $role -eq 'worker')) {
        # A plain task may freely touch anywhere under state root (it has no "own lane" concept
        # beyond its own task file). coordinator/worker are scoped to their own task directory
        # only - this is what keeps a worker out of another worker's worktree or task dir, since
        # sibling worktrees also live under state root.
        $outOfLane = @($stateRootTargets | Where-Object { -not (Test-PathWithin $_ $ownTaskDir) })
        if ($outOfLane) {
            $reason = "impact-guard: $role task $taskPath may only write its own worktree and task directory; out of lane: $($outOfLane -join ', ')"
        }
    }

    if (-not $reason -and $gated -and $role -ne 'coordinator') {
        # \r?$: orchestrate.ps1 writes worker tasks with CRLF, and .NET's $ will not match past
        # the \r that [ \t]* leaves behind. Without it a worker task never reaches this gate.
        if ($content -match '(?m)^code_change:[ \t]*true[ \t]*\r?$') {
            # Stricter than quality-gate: an untouched <placeholder> template counts as unfilled.
            $impact = Get-Section $content 'Impact surface'
            if (-not $impact -or $impact -match '<[^>]*>') {
                $reason = "impact-guard: fill '## Impact surface' in $taskPath before editing code (callers / entrypoints / shared state / unverified nodes)."
            }

            # Same shape as Impact surface, one step earlier: exploring project docs only pays
            # off if it happens before the code gets read, not after. "none - <reason>" is the
            # bootstrap escape hatch for a project that has no docs yet. Unlike Impact surface
            # (whose content cannot be machine-checked), a doc path can be - Test-Path is what
            # keeps "read: docs/whatever.md" from being satisfied by typing a plausible string.
            if (-not $reason) {
                $docsSection = Get-Section $content 'Project docs'
                $readMatch = [regex]::Match($docsSection, '(?mi)^[ \t]*-[ \t]*read:[ \t]*(.+?)[ \t]*\r?$')
                $readValue = if ($readMatch.Success) { $readMatch.Groups[1].Value.Trim() } else { '' }
                if (-not $readValue -or $readValue -match '^<.*>$') {
                    $reason = "impact-guard: fill '## Project docs' - read: in $taskPath before editing code (run project-doc.ps1 -Action Lookup -Paths <paths>, or record 'none - <reason>' if the project has no docs yet)."
                } else {
                    $noneMatch = [regex]::Match($readValue, '(?i)^none[ \t]*-[ \t]*(.+)$')
                    if ($noneMatch.Success) {
                        # "none - <reason>" is itself a two-part claim: the placeholder check above
                        # only catches a wholly-untouched line, not a filled-in "none -" with the
                        # reason half left as <placeholder>.
                        $noneReason = $noneMatch.Groups[1].Value.Trim()
                        if (-not $noneReason -or $noneReason -match '^<.*>$') {
                            $reason = "impact-guard: '## Project docs' - read: none needs an actual reason, not a placeholder, in $taskPath."
                        }
                    } else {
                        $missingDocs = @()
                        foreach ($rawDocPath in ($readValue -split ',')) {
                            $docPath = $rawDocPath.Trim()
                            if (-not $docPath) { continue }
                            $fullDocPath = if ([IO.Path]::IsPathRooted($docPath)) { $docPath } else { Join-Path $resolved.root $docPath }
                            if (-not (Test-Path -LiteralPath $fullDocPath -PathType Leaf)) { $missingDocs += $docPath }
                        }
                        if ($missingDocs) {
                            $reason = "impact-guard: '## Project docs' - read: names a path that does not exist in the repo: $($missingDocs -join ', ')."
                        }
                    }
                }
            }
        }
    }

    if (-not $reason) { exit 0 }
    Write-Deny $reason $isAntigravity
} catch {
    # Releasing the edit on failure is deliberate: a broken guard must not stop work. But a guard
    # that fails silently is indistinguishable from one that passed - git-guard once ran 81 times
    # and succeeded 9, unnoticed, because a parse error looked exactly like "allowed". Leave a
    # trace first; runtime-check.ps1 surfaces it.
    try {
        $logDir = Join-Path $env:USERPROFILE '.agent-workflow\logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        Add-Content -LiteralPath (Join-Path $logDir 'hook-errors.log') -Value ((Get-Date).ToString('s') + "`timpact-guard`t" + $_.Exception.Message) -Encoding UTF8
    } catch { }
}
exit 0
