[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskPath,
    [string]$Cwd,
    [string]$WorktreeId,
    [ValidateSet('Stop', 'Close')][string]$Mode = 'Stop'
)

# Single source of truth for "is this task allowed to finish".
#
# Two callers, deliberately: hooks/quality-gate.ps1 (Stop) decides whether the turn may end,
# and scripts/close-task.ps1 (Close) decides whether status may become `done`. Before this
# split the Stop hook was the only gate, and it only ever looks at `status: in_progress` tasks -
# so writing `status: done` was the one operation nothing checked. Three real tasks shipped
# with every completion criterion unchecked, placeholder validation results and SKIPPED role
# sections through exactly that hole.
#
# Close is Stop plus the checks that only make sense at the finish line (roles must have
# actually run). Keeping both in one script is the point: two copies would drift, and the
# copy nobody reads would be the one guarding the finish line.
#
# Output is always JSON: { issues: [...], waiting: <bool>, waived: <string> }. Callers treat a
# non-empty `issues` as a refusal. Internal failures are reported as an issue rather than an
# exception, so both callers stay fail-closed.

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Get-Section([string]$Content, [string]$Prefix) {
    $escaped = [regex]::Escape($Prefix)
    return [regex]::Match($Content, "(?ms)^## $escaped.*?\r?\n(.*?)(?=^## |\z)").Groups[1].Value.Trim()
}

function Add-MissingSection([string]$Content, [string]$Prefix, [ref]$Issues) {
    $body = Get-Section $Content $Prefix
    if (-not $body -or $body -match '^<.*>$') { $Issues.Value += "missing or empty section: $Prefix" }
}

# A role's verdict is only worth anything against the diff it actually read. The recorded
# fingerprint is compared with the current one; anything edited after the role signed off makes
# them differ and forces a re-run. This is the only check here that cannot be satisfied by
# writing plausible text - it is recomputed from the working tree.
function Add-FingerprintIssue([string]$Section, [string]$Label, [string]$Expected, [ref]$Issues) {
    $match = [regex]::Match($Section, '(?mi)^[ \t]*-[ \t]*diff_sha256:[ \t]*([0-9a-f]{64})[ \t]*\r?$')
    if (-not $match.Success) {
        $Issues.Value += "$Label has no '- diff_sha256: <64-hex>' line recording which diff it reviewed"
        return
    }
    $recorded = $match.Groups[1].Value.ToLowerInvariant()
    if ($recorded -ne $Expected) {
        $Issues.Value += "$Label reviewed diff $($recorded.Substring(0, 12)) but the working tree is now $($Expected.Substring(0, 12)); the diff changed afterwards and it must be re-run"
    }
}

# Shared by read: (Stop+Close, unconditional) and updated: (Close-only, conditional - see
# Add-ProjectDocsUpdateIssue). A field is either "none - <reason>" (reason must not itself be a
# placeholder - the earlier blanket <...> check only catches a wholly-untouched line) or a
# comma-separated path list, and every named path must actually exist: unlike Impact surface,
# whose content cannot be machine-checked, a doc path can be, so this is what keeps
# "read: docs/whatever.md" from being satisfied by typing a plausible-looking string.
function Test-ProjectDocsField([string]$Value, [string]$Cwd, [string]$FieldLabel) {
    if (-not $Value -or $Value -match '^<.*>$') { return "'## Project docs' has no '- ${FieldLabel}:' line" }
    $noneMatch = [regex]::Match($Value, '(?i)^none[ \t]*-[ \t]*(.+)$')
    if ($noneMatch.Success) {
        $noneReason = $noneMatch.Groups[1].Value.Trim()
        if (-not $noneReason -or $noneReason -match '^<.*>$') {
            return "'## Project docs' - ${FieldLabel}: none needs an actual reason, not a placeholder"
        }
        return ''
    }
    if (-not $Cwd) { return '' }
    $missing = @()
    foreach ($rawDocPath in ($Value -split ',')) {
        $docPath = $rawDocPath.Trim()
        if (-not $docPath) { continue }
        $fullDocPath = if ([IO.Path]::IsPathRooted($docPath)) { $docPath } else { Join-Path $Cwd $docPath }
        if (-not (Test-Path -LiteralPath $fullDocPath -PathType Leaf)) { $missing += $docPath }
    }
    if ($missing) { return "'## Project docs' - ${FieldLabel}: names a path that does not exist: $($missing -join ', ')" }
    return ''
}

# Test-ProjectDocsField only proves the named path exists - it says nothing about whether that
# file is actually a valid doc (correct frontmatter, non-empty required sections). project-doc.ps1
# -Action Check is the authority for doc format and already exists for exactly this, but nothing
# called it: `read: docs/whatever.md` was satisfiable by any file with that name, the same
# "configured but never checked" gap this framework's own README calls out for
# project-architecture-index (see project-docs.md). Only applied to read: (Add-ProjectDocsIssue),
# not updated: - the field-existence rules already differ the same way, and a malformed doc that
# was merely re-confirmed (not authored) this turn is not this task's problem to fix.
function Add-ProjectDocsFormatIssues([string]$Value, [string]$Cwd, [ref]$Issues) {
    if (-not $Cwd) { return }
    if ([regex]::IsMatch($Value, '(?i)^none[ \t]*-')) { return }
    $projectDocScript = Join-Path $PSScriptRoot 'project-doc.ps1'
    if (-not (Test-Path -LiteralPath $projectDocScript)) { return }
    foreach ($rawDocPath in ($Value -split ',')) {
        $docPath = $rawDocPath.Trim()
        if (-not $docPath) { continue }
        $fullDocPath = if ([IO.Path]::IsPathRooted($docPath)) { $docPath } else { Join-Path $Cwd $docPath }
        # A missing path is already reported by Test-ProjectDocsField; do not double-report it
        # here, and do not hand a nonexistent path to -Action Check, which would throw.
        if (-not (Test-Path -LiteralPath $fullDocPath -PathType Leaf)) { continue }
        try {
            $checkRaw = (& $projectDocScript -Action Check -Doc $fullDocPath -RepoRoot $Cwd | Out-String)
            $checkResult = $checkRaw | ConvertFrom-Json
        } catch {
            $Issues.Value += "'## Project docs' - read: could not run project-doc.ps1 -Action Check on ${docPath}: $($_.Exception.Message)"
            continue
        }
        # -Doc mode normally returns a one-element JSON array; PowerShell's ConvertFrom-Json
        # unwraps a single-element array back to a bare object, so @() is needed on the way out
        # regardless of which shape came back (same trap documented in worktree-fingerprint.ps1).
        foreach ($entry in @($checkResult)) {
            foreach ($docIssue in @($entry.issues)) {
                $Issues.Value += "'## Project docs' - read: ${docPath} fails project-doc.ps1 -Action Check: $docIssue"
            }
        }
    }
}

# Mirrors impact-guard.ps1's own Project docs check, deliberately not shared code: impact-guard
# fires on every Edit/Write (a hot path with no Cwd resolution cost to spare) while this runs
# once at Stop/Close. The two already duplicate the same Impact surface check for the same
# reason - see the "Stricter than quality-gate" comment in impact-guard.ps1.
function Add-ProjectDocsIssue([string]$Content, [string]$Cwd, [ref]$Issues) {
    $section = Get-Section $Content 'Project docs'
    if (-not $section) { $Issues.Value += "missing or empty section: Project docs"; return }
    $match = [regex]::Match($section, '(?mi)^[ \t]*-[ \t]*read:[ \t]*(.+?)[ \t]*\r?$')
    $value = if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
    $issue = Test-ProjectDocsField $value $Cwd 'read'
    if ($issue) {
        $Issues.Value += "$issue (run project-doc.ps1 -Action Lookup, or record 'none - <reason>')"
        return
    }
    Add-ProjectDocsFormatIssues $value $Cwd $Issues
}

# Close-only, conditional on the same trigger SKILL.md's own write-side rule uses: a structural
# change (feature/refactor, or a risk flag whose entire point is "this changed something worth
# documenting") must record what got updated, or say why nothing needed to. A bug fix or chore
# is exempt - this gate enforces exactly the rule already written in SKILL.md section 4, it does
# not invent a stricter one. Unlike read:, this is the one place in the whole mechanism where the
# production side is actually checked; see project-docs.md for why read: alone was not enough.
function Add-ProjectDocsUpdateIssue([string]$Content, [string]$Cwd, [string]$ChangeKind, [string[]]$Flags, [ref]$Issues) {
    $triggerFlags = @('behavior_change', 'contract', 'schema', 'cross_feature')
    $triggered = (@('feature', 'refactor') -contains $ChangeKind) -or (@($Flags | Where-Object { $triggerFlags -contains $_ }).Count -gt 0)
    if (-not $triggered) { return }
    $section = Get-Section $Content 'Project docs'
    $match = [regex]::Match($section, '(?mi)^[ \t]*-[ \t]*updated:[ \t]*(.+?)[ \t]*\r?$')
    $value = if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
    $issue = Test-ProjectDocsField $value $Cwd 'updated'
    if ($issue) { $Issues.Value += "$issue (change_kind $ChangeKind, or a documentation-triggering risk flag, requires a disposition here)" }
}

$issues = @()
$isWaitingCoordinator = $false
$rolesWaived = ''

try {
    if (-not (Test-Path -LiteralPath $TaskPath)) {
        Write-Output (@{ issues = @("task file not found: $TaskPath"); waiting = $false; waived = '' } | ConvertTo-Json -Depth 5 -Compress)
        exit 0
    }

    $rawContent = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8
    $content = [regex]::Replace($rawContent, '(?s)<!--.*?-->', '')

    $validator = Join-Path $PSScriptRoot 'validate-task.ps1'
    $frontmatter = (& $validator -TaskPath $TaskPath | Out-String) | ConvertFrom-Json
    if (-not $frontmatter.valid) { $issues += @($frontmatter.errors) }
    if ($WorktreeId -and $frontmatter.data.worktree_id -ne $WorktreeId) { $issues += 'task worktree_id does not match the current worktree' }
    foreach ($field in @('id','project_id','worktree_id','status','code_change','risk_flags','created_at','updated_at')) {
        if ($content -notmatch "(?m)^${field}:[ \t]*\S+") { $issues += "missing frontmatter field: $field" }
    }
    # \r?$ on every frontmatter anchor, not just $: in .NET multiline mode $ matches immediately
    # before a bare \n, and [ \t]* does not consume the \r of a CRLF line, so a CRLF task file
    # would fail every one of these checks. orchestrate.ps1 writes worker tasks with CRLF, which
    # is exactly the case that has to keep working. Matches the convention already used by the
    # Reviewer/Verifier PASS-line patterns further down.
    if ($content -notmatch '(?m)^status:[ \t]*in_progress[ \t]*\r?$') { $issues += 'active task status is invalid' }

    # The user may waive the independent roles, but only explicitly and only in frontmatter -
    # writing "SKIPPED - user explicitly requested" inside the Reviewer section is what used to
    # pass for a waiver, and it was indistinguishable from an agent skipping the roles itself.
    # A waiver relaxes the role sections and nothing else: completion criteria, pre-review,
    # impact surface and mutation check all still apply.
    if ($content -match '(?m)^roles_waived:[ \t]*(.+?)[ \t]*\r?$') { $rolesWaived = $Matches[1].Trim() }
    if ($rolesWaived -match '^<.*>$') { $rolesWaived = '' }

    $independence = if ($content -match '(?m)^independence:[ \t]*(\S+)') { $Matches[1] } else { '' }

    # A coordinator waiting on non-terminal workers is a legitimate stop point (Manual mode
    # requires the coordinator to end its turn while workers run elsewhere). Everything that
    # only becomes meaningful after integration - unchecked completion items (the coordinator's
    # own criteria legitimately can't all be checked yet), Validation results/pre-review, the
    # code_change role gate below, and the coordinator's own four sections - is skipped for
    # that one turn instead of blocking it. This must be decided BEFORE the unchecked-items
    # check below, not after: that check has no role awareness of its own.
    #
    # Close mode never takes the relaxation: "waiting for workers" and "finished" are mutually
    # exclusive, and check-task -Mode Coordinator refuses a non-terminal roster anyway.
    $subtaskRole = if ($content -match '(?m)^subtask_role:[ \t]*(\S+)') { $Matches[1] } else { '' }
    if ($subtaskRole -eq 'coordinator') {
        $checkTaskPath = Join-Path $PSScriptRoot 'check-task.ps1'
        if (Test-Path -LiteralPath $checkTaskPath) {
            # issues (e.g. a broken frontmatter field) can be non-empty even while waiting_for is
            # set - check-task.ps1's waiting branch returns both. Merging them unconditionally
            # means a coordinator with invalid frontmatter cannot hide behind "waiting" to stop
            # cleanly; only the integration-only requirements below are what waiting skips.
            $coordCheck = (& $checkTaskPath -TaskPath $TaskPath -Mode Coordinator | Out-String) | ConvertFrom-Json
            $issues += @($coordCheck.issues)
            if ($Mode -eq 'Stop' -and $coordCheck.PSObject.Properties['waiting_for']) { $isWaitingCoordinator = $true }
        }
    }

    if (-not $isWaitingCoordinator) {
        $unchecked = [regex]::Matches($content, '(?m)^\s*-\s*\[ \]\s+(.+)$') |
            ForEach-Object { $_.Groups[1].Value.Trim() }
        if ($unchecked) { $issues += "unchecked completion items: $($unchecked -join '; ')" }
    }

    $baseSections = if ($isWaitingCoordinator) { @('Goal','Scope','Completion criteria') } else { @('Goal','Scope','Completion criteria','Validation results') }
    foreach ($section in $baseSections) {
        Add-MissingSection $content $section ([ref]$issues)
    }

    $validation = Get-Section $content 'Validation results'
    $preReviewPassed = $false
    if (-not $isWaitingCoordinator) {
        $preReview = [regex]::Match($validation, '(?mi)^\s*-\s*pre-review:\s*(PASS|SKIP)\s*$')
        if (-not $preReview.Success) {
            $issues += 'pre-review result must be PASS or SKIP'
        } elseif ($preReview.Groups[1].Value -eq 'SKIP') {
            $skipReason = [regex]::Match($validation, '(?mi)^\s*-\s*skip reason:\s*(.+)$').Groups[1].Value.Trim()
            if (-not $skipReason -or $skipReason -match '^<.*>$') { $issues += 'SKIP pre-review requires a reason' }
        } else {
            $preReviewPassed = $true
        }
    }

    $riskLine = if ($content -match '(?m)^risk_flags:[ \t]*\[(.*?)\][ \t]*\r?$') { $Matches[1] } else { '' }
    $flags = @($riskLine -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    # Parsed here (not just at Close, where the retrospective section needs it) because the
    # Behavior invariants section below is keyed on it too, and both Stop and Close must agree
    # on what counts as a refactor.
    $changeKind = if ($content -match '(?m)^change_kind:[ \t]*(\S+)[ \t]*\r?$') { $Matches[1] } else { '' }
    # The allowed set and the freeze/contract/adversarial subsets used to be hard-coded copies in
    # the Stop hook, able to drift from schemas/task.schema.json without any test noticing. The
    # schema is the single source; a gate that cannot read it must fail closed rather than guess.
    $taskSchemaPath = Join-Path $PSScriptRoot '..\schemas\task.schema.json'
    $taskSchema = $null
    if (Test-Path -LiteralPath $taskSchemaPath) {
        $taskSchema = Get-Content -LiteralPath $taskSchemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    if (-not $taskSchema) { $issues += "task schema is unreadable: $taskSchemaPath" }
    $allowedFlags = @($taskSchema.properties.risk_flags.items.enum)
    foreach ($flag in $flags) { if ($allowedFlags -notcontains $flag) { $issues += "unknown risk flag: $flag" } }
    $freezeFlags = @($taskSchema.x_agent_workflow.freeze_required)
    $contractFlags = @($taskSchema.x_agent_workflow.contract_impact_required)
    $adversarialFlags = @($taskSchema.x_agent_workflow.adversarial_required)
    $mutationFlags = @($taskSchema.x_agent_workflow.mutation_check_required)
    $needsFreeze = @($flags | Where-Object { $freezeFlags -contains $_ }).Count -gt 0
    # Impact surface / Execution path / Reviewer / Verifier only become meaningful once
    # integration has happened; a waiting coordinator has not reached that point yet.
    $isCodeChange = $frontmatter.code_change -eq $true
    $needsReviewer = $isCodeChange -and -not $isWaitingCoordinator
    $needsVerifier = $isCodeChange -and -not $isWaitingCoordinator

    if ($needsFreeze) {
        if ($content -notmatch '(?m)^frozen_at:[ \t]*\S+[ \t]*\r?$') { $issues += 'freeze-required task has no frozen_at' }
        foreach ($section in @('Non-goals and compatibility','Current state and impact','Decision and tradeoffs','Boundary and error paths','User confirmation')) {
            if ($content -notmatch "(?m)^## $([regex]::Escape($section))") { $issues += "missing section: $section" }
        }
    }
    if ($needsFreeze -or ($flags -contains 'behavior_change') -or ($flags -contains 'ui')) {
        Add-MissingSection $content 'Acceptance cases' ([ref]$issues)
    }
    if (@($flags | Where-Object { $contractFlags -contains $_ }).Count -gt 0) {
        Add-MissingSection $content 'Contract and data impact' ([ref]$issues)
    }
    if (@($flags | Where-Object { @('cross_feature','migration','irreversible') -contains $_ }).Count -gt 0) {
        Add-MissingSection $content 'Implementation sequence' ([ref]$issues)
    }
    if ($flags -contains 'ui') {
        Add-MissingSection $content 'Browser verification' ([ref]$issues)
    }
    # Keyed on change_kind, not a risk_flags value: `refactor` used to mean two different things
    # (a change_kind AND a risk flag, with no rule saying whether setting one implied the other).
    # change_kind already answers "is this a refactor" without a second, redundant flag to keep
    # in sync with it.
    if ($changeKind -eq 'refactor') {
        Add-MissingSection $content 'Behavior invariants and before-after evidence' ([ref]$issues)
    }

    # "The tests are green" has repeatedly meant "the assertions never ran": a contract test whose
    # CJK literal was mojibaked so -notmatch was always true, and a fixture hard-coded to the
    # passing shape so the case it named could not fail. Breaking the change on purpose and
    # watching the test go red is the only cheap way to tell a real assertion from a decorative
    # one, so it is required exactly where a false green costs the most.
    if ($needsReviewer -and @($flags | Where-Object { $mutationFlags -contains $_ }).Count -gt 0) {
        $mutation = [regex]::Match($validation, '(?mi)^\s*-\s*mutation check:\s*(PASS|SKIP)\s*$')
        if (-not $mutation.Success) {
            $issues += 'mutation check result must be PASS or SKIP (break the key assertion, confirm the guarding test goes red, then restore)'
        } elseif ($mutation.Groups[1].Value -eq 'SKIP') {
            $mutationReason = [regex]::Match($validation, '(?mi)^\s*-\s*mutation reason:\s*(.+)$').Groups[1].Value.Trim()
            if (-not $mutationReason -or $mutationReason -match '^<.*>$') { $issues += 'SKIP mutation check requires a reason' }
        }
    }

    # Roles cannot be signed off by the main agent standing in for them. Every degraded task in
    # the history either shipped without the checks or left the sections blank, including a
    # seven-item financial fix whose Reviewer and Verifier were both unavailable.
    #
    # independence used to be optional ("if applicable" in SKILL.md), and nothing ever required
    # it - so it protected only the one turn an agent chose, unprompted, to admit a role was
    # faked. Every real failure mode is the opposite one: the role sections get filled in as if
    # Reviewer/Verifier actually ran, and omitting this field cost nothing, so it was a dead
    # check in practice. Mandatory turns silent omission into an explicit claim - 'native' is
    # now itself asserted, not assumed by default, for the one situation this field exists to
    # catch: role sections that read PASS but were never independently produced.
    if ($Mode -eq 'Close' -and $isCodeChange -and -not $rolesWaived) {
        if ($independence -eq 'degraded') {
            $issues += 'independence: degraded - the independent roles did not run; set status to blocked and record the next step, or have the user authorise roles_waived'
        } elseif ($independence -ne 'native') {
            $issues += "independence must be 'native' or 'degraded' before closing (missing or invalid value: '$independence')"
        }
    }

    $currentFingerprint = $null
    if ($needsReviewer -and $Cwd) {
        $fingerprintScript = Join-Path $PSScriptRoot 'worktree-fingerprint.ps1'
        if (Test-Path -LiteralPath $fingerprintScript) {
            $baseCommit = if ($content -match '(?m)^base_commit:[ \t]*([0-9a-f]{40})[ \t]*\r?$') { $Matches[1] } else { '' }
            # Hashtable splatting, not array: array splatting binds elements positionally, so
            # @('-Path', $Cwd) passes the literal string "-Path" as the first parameter value.
            $fingerprintArgs = @{ Path = $Cwd }
            if ($baseCommit) { $fingerprintArgs['Base'] = $baseCommit }
            $fingerprintResult = (& $fingerprintScript @fingerprintArgs | Out-String) | ConvertFrom-Json
            if ($fingerprintResult -and $fingerprintResult.sha256) { $currentFingerprint = [string]$fingerprintResult.sha256 }
            else { $issues += "cannot compute the working tree fingerprint: $($fingerprintResult.error)" }
        }
    }

    if ($needsReviewer) {
        Add-ProjectDocsIssue $content $Cwd ([ref]$issues)
        Add-MissingSection $content 'Impact surface' ([ref]$issues)
        Add-MissingSection $content 'Execution path and regression evidence' ([ref]$issues)
        if ($currentFingerprint -and $preReviewPassed) {
            Add-FingerprintIssue $validation 'pre-review' $currentFingerprint ([ref]$issues)
        }
    }

    if ($needsReviewer -and -not $rolesWaived) {
        $review = Get-Section $content 'Reviewer result'
        if (-not $review -or $review -match '^<.*>$' -or $review -notmatch '(?mi)^[ \t]*-[ \t]*result:[ \t]*PASS[ \t]*\r?$') { $issues += 'Reviewer result is missing or not passed' }
        # Reviewer's eight dimensions and their N/A-eligibility used to be a hand-copied literal
        # here and a second, independent hand-copied literal in check-task.ps1 - the two have
        # already drifted once (check-task.ps1 was missing "Failure modes and observability" and
        # silently accepted a worker delivery with no verdict on it). schema is the single source
        # for every other flag-driven list in this file; an unreadable schema already fails
        # closed above, so this list degrades the same way instead of falling back to a literal
        # that could go stale again unnoticed.
        foreach ($dim in @($taskSchema.x_agent_workflow.reviewer_dimensions)) {
            $dimension = [string]$dim.name
            $allowedStatus = if ($dim.na_allowed) { '(?:PASS|N/A)' } else { 'PASS' }
            $dimensionPattern = '(?mi)^[ \t]*-[ \t]*' + [regex]::Escape($dimension) + ':[ \t]*' + $allowedStatus + '(?:[ \t]+.*)?[ \t]*\r?$'
            if ($review -notmatch $dimensionPattern) { $issues += "Reviewer result missing or not passed dimension: $dimension" }
        }
        if ($currentFingerprint) { Add-FingerprintIssue $review 'Reviewer result' $currentFingerprint ([ref]$issues) }

        # The adversarial round is the only defence on the six flags whose common property is
        # that being accidentally right is expensive, and until now it was the only role with no
        # gate at all. Its checks do not take N/A: "this change has no assumptions worth
        # attacking" is exactly the claim that needs to be written out and defended.
        if (@($flags | Where-Object { $adversarialFlags -contains $_ }).Count -gt 0) {
            $adversarial = Get-Section $content 'Adversarial result'
            if (-not $adversarial -or $adversarial -match '^<.*>$' -or $adversarial -notmatch '(?mi)^[ \t]*-[ \t]*result:[ \t]*PASS[ \t]*\r?$') { $issues += 'Adversarial result is missing or not passed' }
            foreach ($check in @('Provenance','Pattern fan-out','Engine semantics','Cross-round accumulation')) {
                $checkPattern = '(?mi)^[ \t]*-[ \t]*' + [regex]::Escape($check) + ':[ \t]*PASS(?:[ \t]+.*)?[ \t]*\r?$'
                if ($adversarial -notmatch $checkPattern) { $issues += "Adversarial result missing or not passed check: $check" }
            }
            if ($currentFingerprint) { Add-FingerprintIssue $adversarial 'Adversarial result' $currentFingerprint ([ref]$issues) }
        }
    }

    if ($needsVerifier -and -not $rolesWaived) {
        $verify = Get-Section $content 'Verifier result'
        if (-not $verify -or $verify -match '^<.*>$' -or $verify -notmatch '(?mi)^[ \t]*-[ \t]*PASS[ \t]*\r?$') { $issues += 'Verifier result is missing or not passed' }
        if ($currentFingerprint) { Add-FingerprintIssue $verify 'Verifier result' $currentFingerprint ([ref]$issues) }
    }

    # The only check here that asks about the framework rather than the change. Every other rule
    # in this file was added after a specific incident, by hand, because somebody remembered; this
    # one makes a fix state whether it was a regression and, if so, which gate let it through.
    #
    # Close-only, like the independence check: a fix that stops half-way must still end its turn.
    # A waiver does not relax it - roles_waived says the independent roles did not run, not that
    # the framework is exempt from being asked why it missed something.
    #
    # Workers are exempt: a worker is one slice of a fix and its parent coordinator answers for
    # the whole. That also keeps orchestrate.ps1's worker frontmatter, which has no change_kind,
    # valid without changing it.
    if ($Mode -eq 'Close' -and $isCodeChange -and $subtaskRole -ne 'worker') {
        Add-ProjectDocsUpdateIssue $content $Cwd $changeKind $flags ([ref]$issues)
        if (-not $changeKind) {
            $issues += 'code change has no change_kind (fix | feature | refactor | chore); a fix must record a retrospective before it can close'
        } else {
            $retroKinds = @($taskSchema.x_agent_workflow.retrospective_required)
            if ($retroKinds -contains $changeKind) {
                # The vocabulary lives in retro.schema.json so retro.ps1 and this gate cannot
                # drift. Unreadable means fail closed, same as an unreadable task schema.
                $retroSchemaPath = Join-Path $PSScriptRoot '..\schemas\retro.schema.json'
                $retroSchema = $null
                if (Test-Path -LiteralPath $retroSchemaPath) {
                    $retroSchema = Get-Content -LiteralPath $retroSchemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
                }
                if (-not $retroSchema) { $issues += "retro schema is unreadable: $retroSchemaPath" }

                $retro = Get-Section $content 'Retrospective result'
                if (-not $retro -or $retro -match '^<.*>$') {
                    $issues += 'missing or empty section: Retrospective result'
                } else {
                    $introduced = [regex]::Match($retro, '(?mi)^[ \t]*-[ \t]*introduced_by:[ \t]*(.+?)[ \t]*\r?$').Groups[1].Value.Trim()
                    if (-not $introduced -or $introduced -match '^<.*>$') {
                        # Without this, filling in classification alone is the cheap way out and
                        # every fix quietly becomes pre_existing.
                        $issues += 'Retrospective result has no introduced_by (a commit sha, or "unknown - <what was searched>")'
                    }
                    $classification = [regex]::Match($retro, '(?mi)^[ \t]*-[ \t]*classification:[ \t]*(\S+)[ \t]*\r?$').Groups[1].Value
                    $classifications = @($retroSchema.properties.classification.enum)
                    if (-not $classification -or $classifications -notcontains $classification) {
                        $issues += "Retrospective result needs a classification from: $($classifications -join ', ')"
                    } elseif (@($retroSchema.x_agent_workflow.gap_required) -contains $classification) {
                        $missCategory = [regex]::Match($retro, '(?mi)^[ \t]*-[ \t]*miss_category:[ \t]*(\S+)[ \t]*\r?$').Groups[1].Value
                        $missCategories = @($retroSchema.properties.miss_category.enum)
                        if (-not $missCategory -or $missCategories -notcontains $missCategory) {
                            $issues += "a regression needs a miss_category from: $($missCategories -join ', ')"
                        }
                        $gapEvidence = [regex]::Match($retro, '(?mi)^[ \t]*-[ \t]*gap_evidence:[ \t]*(.+?)[ \t]*\r?$').Groups[1].Value.Trim()
                        if (-not $gapEvidence -or $gapEvidence -match '^<.*>$') {
                            $issues += 'a regression needs gap_evidence naming which task section or gate let it through'
                        }
                        # Either it was written down where the framework work is picked up, or
                        # there is a stated reason it does not need to be. "We should be careful"
                        # is not a disposition.
                        $frameworkChange = [regex]::Match($retro, '(?mi)^[ \t]*-[ \t]*framework_change:[ \t]*(.+?)[ \t]*\r?$').Groups[1].Value.Trim()
                        if ($frameworkChange -notmatch '^(recorded:[0-9]{8}-[0-9]{6}-[a-f0-9]{8}|not_needed[ \t]*-[ \t]*\S.*)$') {
                            $issues += 'a regression needs framework_change: either "recorded:<retro-id>" from retro.ps1 -Action Record, or "not_needed - <reason>"'
                        } elseif ($frameworkChange -match '^recorded:([0-9]{8}-[0-9]{6}-[a-f0-9]{8})$') {
                            # Shape-checking the id only proved the agent can count hex digits. The
                            # id exists to point at a finding somebody will pick up later, so the
                            # finding has to be there: an id that resolves to nothing is a
                            # retrospective that was written but never recorded, which is the exact
                            # outcome this whole loop exists to prevent.
                            $retroId = $Matches[1]
                            # Derived from the task path, not $env:USERPROFILE: a task always lives
                            # at <state-root>/projects/<pid>/tasks/<task-id>/task.md, and retro.ps1
                            # takes a -StateRoot that the tests do point elsewhere. Reading the
                            # real store while the task under inspection belongs to a temporary one
                            # would make this check pass or fail for reasons nothing in the task
                            # can explain.
                            $stateRoot = $TaskPath
                            for ($i = 0; $i -lt 5; $i++) { $stateRoot = Split-Path -Parent $stateRoot }
                            if (-not $stateRoot) { $stateRoot = Join-Path $env:USERPROFILE '.agent-workflow' }
                            $retroIndexPath = Join-Path $stateRoot 'retro\index.json'
                            $known = $false
                            $lookupError = ''
                            if (-not (Test-Path -LiteralPath $retroIndexPath)) {
                                $lookupError = "no retro store at $retroIndexPath"
                            } else {
                                try {
                                    $retroIndex = Get-Content -LiteralPath $retroIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
                                    if ($null -eq $retroIndex.entries) { $lookupError = 'retro index has no entries array' }
                                    else { $known = @($retroIndex.entries | Where-Object { $_.id -eq $retroId }).Count -gt 0 }
                                } catch {
                                    $lookupError = "retro index is unreadable: $($_.Exception.Message)"
                                }
                            }
                            if (-not $known) {
                                $detail = if ($lookupError) { " ($lookupError)" } else { '' }
                                $issues += "framework_change names retro finding $retroId, but no such finding exists$detail; record it with retro.ps1 -Action Record -ProposedChange '<change>'"
                            }
                        }
                    }
                }
            }
        }
    }
} catch {
    $issues += "task-gate failed to inspect the task: $($_.Exception.Message)"
}

Write-Output (@{ issues = @($issues); waiting = $isWaitingCoordinator; waived = $rolesWaived } | ConvertTo-Json -Depth 5 -Compress)
exit 0
