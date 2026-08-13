$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$agents = Get-Content -LiteralPath (Join-Path $root 'AGENTS.md') -Encoding UTF8
$workflow = Get-Content -LiteralPath (Join-Path $root '.agents\skills\workflow\SKILL.md') -Encoding UTF8
Assert ($agents.Count -le 40) 'AGENTS.md exceeds 40 lines.'
Assert ($workflow.Count -le 200) 'workflow/SKILL.md exceeds 200 lines.'
Assert (($agents + $workflow) -match 'non-code tasks bypass workflow') 'non-code tasks are not routed around workflow'
# These four terms were written as literal CJK. This file has no BOM, so PowerShell 5.1 read it
# as ANSI, the literals arrived mojibaked, and -notmatch was unconditionally true - the assertion
# had never once run. Encode by code point, the convention already used further down.
$cjkLightTrack = -join @([char]0x8F15, [char]0x8ECC)                  # light track
$cjkStandardTrack = -join @([char]0x6A19, [char]0x6E96, [char]0x8ECC) # standard track
$cjkHeavyTrack = -join @([char]0x91CD, [char]0x8ECC)                  # heavy track
Assert (-not (($agents + $workflow) -match "L0|$cjkLightTrack|$cjkStandardTrack|$cjkHeavyTrack")) 'v3 tracks remain in runtime context.'
Assert (($agents + $workflow) -match 'pre-review') 'pre-review is missing from runtime instructions.'
Assert (($agents + $workflow) -match 'TDD') 'TDD requirement is missing from runtime instructions.'
Assert ($workflow -match '~/.agent-workflow/runtime/scripts/pre-review.ps1') 'workflow does not use the managed pre-review runtime path.'

foreach ($path in @(
    '.agents\agents\reviewer.md','.agents\agents\adversarial.md','.agents\agents\verifier.md','hooks\git-guard.ps1','hooks\quality-gate.ps1','hooks\impact-guard.ps1',
    'scripts\project-resolver.ps1','scripts\knowledge.ps1','scripts\pre-review.ps1','scripts\validate-task.ps1','templates\task.md','schemas\project.schema.json',
    'schemas\knowledge.schema.json','schemas\task.schema.json','schemas\import-manifest.schema.json',
    'scripts\task-gate.ps1','scripts\close-task.ps1','scripts\worktree-fingerprint.ps1','scripts\runtime-check.ps1',
    '.agents\agents\retrospective.md','scripts\retro.ps1','schemas\retro.schema.json',
    'scripts\project-doc.ps1'
)) { Assert (Test-Path -LiteralPath (Join-Path $root $path)) "Missing required file: $path" }

Get-ChildItem -LiteralPath (Join-Path $root 'schemas') -Filter '*.json' | ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
}

$task = Get-Content -LiteralPath (Join-Path $root 'templates\task.md') -Raw -Encoding UTF8
foreach ($field in @('id:','project_id:','worktree_id:','status:','code_change:','risk_flags:','created_at:','updated_at:','frozen_at:')) {
    Assert ($task.Contains($field)) "Task template missing $field"
}
foreach ($section in @('Goal','Scope','Completion criteria','Validation results','Acceptance cases','Contract and data impact','Implementation sequence')) {
    Assert ($task.Contains($section)) "Task template missing $section"
}
Assert ($task.Contains('Execution path and regression evidence')) 'Task template missing execution path regression evidence'
Assert ($task.Contains('Impact surface')) 'Task template missing Impact surface'
$reviewer = Get-Content -LiteralPath (Join-Path $root '.agents\agents\reviewer.md') -Raw -Encoding UTF8
foreach ($dimension in @('Architecture consistency','Code quality and conventions','Data consistency','Security','Risk and compatibility','Performance','Flow and impact completeness','Failure modes and observability')) {
    Assert ($reviewer.Contains($dimension)) "Reviewer missing dimension: $dimension"
    Assert ($task.Contains($dimension)) "Task template missing Reviewer dimension: $dimension"
}
# The dimension count is stated in the role's own description, which install.ps1 copies into all
# three platforms; leaving it at seven would ship a contradiction.
$cjkEightDimensions = -join @([char]0x516B, [char]0x9762, [char]0x5411)   # eight dimensions
Assert ($reviewer -match $cjkEightDimensions) 'Reviewer description still claims a different dimension count'
$taskSchema = Get-Content -LiteralPath (Join-Path $root 'schemas\task.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert (@($taskSchema.required) -contains 'code_change') 'task schema does not require code_change'
Assert ($taskSchema.properties.code_change.type -eq 'boolean') 'task schema code_change is not boolean'
$workflowText = $workflow -join "`n"
Assert ($workflowText -match 'code_change: true') 'workflow does not define the code-change role gate'
Assert ($workflowText -match 'code_change: false') 'workflow does not define legacy code_change false compatibility'
# Same latent-mojibake bug as the v3-track assertion above: this pattern was a literal too, so it
# never matched anything under PowerShell 5.1 and the check was decorative.
$cjkForces = -join @([char]0x5F37, [char]0x5236)   # forces
Assert ($workflowText -notmatch "$cjkForces Reviewer $([char]0x2192) Verifier") 'risk flags still force Reviewer and Verifier'
Assert ($workflowText -match 'non-code tasks do not enter this workflow') 'non-code tasks are not excluded from workflow'
Assert ($workflowText -match 'A.*B.*C.*D') 'workflow does not require full execution-path review'
Assert ($reviewer -match 'A.*B.*C.*D') 'Reviewer does not require full execution-path review'
Assert ($reviewer -match 'unverified nodes') 'Reviewer does not require explicit unverified-node reporting'
Assert ($reviewer -match 'Impact surface') 'Reviewer does not cross-check the task impact surface'
Assert ($reviewer -match 'knowledge\.ps1') 'Reviewer does not read project knowledge'
Assert ($workflowText -match 'Impact surface') 'workflow does not require an impact surface before implementation'
Assert ($workflow -match '~/.agent-workflow/runtime/scripts/knowledge.ps1') 'workflow does not use the managed knowledge runtime path'
$verifier = Get-Content -LiteralPath (Join-Path $root '.agents\agents\verifier.md') -Raw -Encoding UTF8
Assert ($verifier -match 'real entrypoint') 'Verifier does not start verification from the real entrypoint'
Assert ($verifier -match 'local-only verification') 'Verifier still permits local-only verification'

# --- adversarial review contract ---
# The only role whose activation is driven by risk_flags rather than code_change. Its trigger
# set must be stated identically in the role, the workflow skill and risk-flags.md, or the
# three would drift and the round would silently stop being run.
$adversarial = Get-Content -LiteralPath (Join-Path $root '.agents\agents\adversarial.md') -Raw -Encoding UTF8
$riskFlagsText = Get-Content -LiteralPath (Join-Path $root '.agents\skills\workflow\risk-flags.md') -Raw -Encoding UTF8
$adversarialTriggers = @('financial','data_write','migration','irreversible','schema','contract')
foreach ($flag in $adversarialTriggers) {
    Assert (@($taskSchema.properties.risk_flags.items.enum) -contains $flag) "adversarial trigger is not a real risk flag: $flag"
    Assert ($adversarial -match [regex]::Escape($flag)) "adversarial role does not list its trigger flag: $flag"
    Assert ($workflowText -match [regex]::Escape($flag)) "workflow skill does not list the adversarial trigger flag: $flag"
    Assert ($riskFlagsText -match [regex]::Escape($flag)) "risk-flags.md does not list the adversarial trigger flag: $flag"
}
# The four fixed checks are the whole point of the role; a summary that drops one is a regression.
# They are also gate-enforced line items now, so the role, the skill, the template and the gate
# must agree on the exact names.
$gate = Get-Content -LiteralPath (Join-Path $root 'scripts\task-gate.ps1') -Raw -Encoding UTF8
foreach ($check in @('provenance','pattern fan-out','engine semantics','cross-round accumulation')) {
    Assert ($adversarial -match [regex]::Escape($check)) "adversarial role is missing its fixed check: $check"
    Assert ($workflowText -match [regex]::Escape($check)) "workflow skill is missing the adversarial check: $check"
    Assert ($gate -match [regex]::Escape($check)) "task-gate does not enforce the adversarial check: $check"
    Assert ($task -match [regex]::Escape($check)) "task template is missing the adversarial check line: $check"
}
Assert ($adversarial -notmatch 'sibling consistency') 'adversarial role still uses the retired sibling-consistency name'
Assert ($workflowText -match '6a') 'workflow skill does not define the adversarial round (section 6a)'
Assert ($riskFlagsText -match 'agent-workflow-adversarial') 'risk-flags.md does not cross-reference the adversarial role'
Assert ($task.Contains('Adversarial result')) 'Task template missing Adversarial result'
$manifest = Get-Content -LiteralPath (Join-Path $root 'adapters\managed-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert (@($manifest.runtime) -contains 'scripts/pre-review.ps1') 'managed runtime is missing pre-review.ps1'
Assert (@($manifest.runtime) -contains 'hooks/impact-guard.ps1') 'managed runtime is missing impact-guard.ps1'
$installer = Get-Content -LiteralPath (Join-Path $root 'install.ps1') -Raw -Encoding UTF8
Assert ($installer -match 'CanonicalRoot') 'installer does not define the canonical global root'
Assert ($installer -match 'Install-CanonicalEntrypoints') 'installer does not install canonical entrypoints'
Assert ($installer -match 'Install-CanonicalSharedSources') 'installer does not install shared canonical sources'
Assert ($installer -match 'CanonicalRoot.*agents\\reviewer') 'installer does not route agent generation through canonical sources'
Assert ($installer -match 'canonical-hardlink') 'installer does not track canonical hard links'
# A role that is not in the manifest and not in the installer loops never reaches any platform,
# no matter how completely it is documented.
Assert (@($manifest.runtime) -contains 'agents/adversarial.md') 'managed runtime is missing agents/adversarial.md'
foreach ($platform in @('claude','codex','antigravity')) {
    Assert (@($manifest.platform_files.$platform) -match 'agent-workflow-adversarial') "platform $platform does not ship the adversarial agent"
}
Assert ($installer -match "'reviewer','adversarial','verifier'") 'installer does not generate the adversarial agent for every platform'
foreach ($removed in @('acceptance','templates/spec.md','templates/checklist.md','templates/plan.md','templates/mini-spec.md')) {
    Assert (-not (@($manifest.runtime) -match [regex]::Escape($removed))) "legacy artifact returned to runtime manifest: $removed"
}

# --- coordinator/worker orchestration contract ---

foreach ($path in @('.agents\agents\worker.md','.agents\skills\workflow\orchestration.md')) {
    Assert (Test-Path -LiteralPath (Join-Path $root $path)) "Missing required file: $path"
}

# The worker role must stay thin: behaviour lives in the workflow skill, not restated here.
$worker = Get-Content -LiteralPath (Join-Path $root '.agents\agents\worker.md') -Encoding UTF8
Assert ($worker.Count -le 40) 'agents/worker.md exceeds 40 lines.'
$workerText = $worker -join "`n"
Assert ($workerText -match 'workflow') 'worker role does not defer to the workflow skill'
Assert ($workerText -match 'delivery\.patch') 'worker role does not state that it must not produce the delivery patch'

# orchestration.md is read on every coordinator run; cap it like the other canonical files.
# Raised from 150 to 180 to fit the .agent-workflow-worktree-init.ps1 contract and copy-paste
# example: that script had no template anywhere in the repo, and a prose-only description of
# "populate node_modules/.env without leaving git status dirty" is exactly the kind of instruction
# that gets reimplemented wrong per project. A worked example is worth the extra lines here.
$orchestration = Get-Content -LiteralPath (Join-Path $root '.agents\skills\workflow\orchestration.md') -Encoding UTF8
Assert ($orchestration.Count -le 180) 'workflow/orchestration.md exceeds 180 lines.'
$orchestrationText = $orchestration -join "`n"
foreach ($path in @('agents/worker\.md','skills/workflow/SKILL\.md','skills/workflow/orchestration\.md')) {
    Assert ($orchestrationText -match $path) "orchestration.md is missing a canonical handoff path: $path"
}
# Every .ps1 in this repo stays ASCII-only: PS 5.1 reads no-BOM scripts as ANSI and
# mangles literal CJK. Encode the Traditional Chinese terms by code point instead.
$cjkSandbox = -join @([char]0x6C99, [char]0x7BB1)              # sandbox
$cjkIsolation = -join @([char]0x9694, [char]0x96E2)            # isolation
$cjkCooperative = -join @([char]0x5354, [char]0x4F5C, [char]0x5F0F)  # cooperative
Assert ($orchestrationText -notmatch "$cjkSandbox|sandbox") 'orchestration.md must not claim the worker boundary is a sandbox'
Assert ($orchestrationText -notmatch $cjkIsolation) 'orchestration.md must not describe the worker boundary as isolation'
Assert ($orchestrationText -match $cjkCooperative) 'orchestration.md does not record the cooperative-guard limitation'
Assert ($orchestrationText -match 'Manual') 'orchestration.md does not define the Manual execution mode'

# The freeze exception must be cross-referenced from the canonical rule, not only declared downstream.
$riskFlags = Get-Content -LiteralPath (Join-Path $root '.agents\skills\workflow\risk-flags.md') -Raw -Encoding UTF8
Assert ($riskFlags -match 'orchestration\.md') 'risk-flags.md does not cross-reference the coordinator freeze exception'
Assert ($orchestrationText -match 'frozen_at') 'orchestration.md does not require re-freezing on scope reduction'

# Every new file introduced across all five phases must actually reach the installed runtime,
# not just exist in the repo - Phase 2's orchestrate.ps1/check-task.ps1 were built but never
# added here, so the installer silently never shipped them until this was caught manually.
foreach ($entry in @('agents/worker.md','skills/workflow/orchestration.md','skills/workflow/risk-flags.md','scripts/orchestrate.ps1','scripts/check-task.ps1','scripts/split-plan.ps1')) {
    Assert (@($manifest.runtime) -contains $entry) "managed runtime is missing $entry"
}
# Generalised from that same incident: enumerating known files by hand is how orchestrate.ps1 and
# check-task.ps1 went unshipped for five phases. Every executable under scripts/ and hooks/ must
# be listed, so a new one cannot be forgotten rather than deliberately excluded.
foreach ($directory in @('scripts','hooks')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $directory) -Filter '*.ps1' -File) {
        $entry = "$directory/$($file.Name)"
        Assert (@($manifest.runtime) -contains $entry) "managed runtime is missing $entry (the installer will never copy it)"
    }
}

foreach ($field in @('subtask_role','parent_task_id','base_commit','file_ownership','delivery_status','integration_status')) {
    Assert ($taskSchema.properties.PSObject.Properties.Name -contains $field) "task schema is missing optional field: $field"
    Assert (@($taskSchema.required) -notcontains $field) "orchestration field must stay optional in the schema: $field"
}
Assert (@($taskSchema.properties.subtask_role.enum) -contains 'coordinator' -and @($taskSchema.properties.subtask_role.enum) -contains 'worker') 'subtask_role enum is incomplete'
foreach ($state in @('pending','applied','merged','rejected','skipped')) {
    Assert (@($taskSchema.properties.delivery_status.enum) -contains $state) "delivery_status enum is missing $state"
}
foreach ($state in @('pending','conflicted','applied','abandoned')) {
    Assert (@($taskSchema.properties.integration_status.enum) -contains $state) "integration_status enum is missing $state"
}
# partially_applied was retired when Apply moved to per-delivery apply plus hand-merged conflicts:
# a delivery that cannot be applied cleanly is now resolved, not silently left half-integrated.
Assert (@($taskSchema.properties.integration_status.enum) -notcontains 'partially_applied') 'retired partially_applied is still in the integration_status enum'
Assert ($taskSchema.properties.file_ownership.type -eq 'array') 'file_ownership is not an array'

# The freeze-required flag list lived in three hard-coded copies inside quality-gate.ps1; the
# schema is now the single source and the hook must read it rather than restate it.
Assert ($taskSchema.x_agent_workflow.freeze_required) 'task schema does not publish x_agent_workflow.freeze_required'
foreach ($flag in @($taskSchema.x_agent_workflow.freeze_required)) {
    Assert (@($taskSchema.properties.risk_flags.items.enum) -contains $flag) "freeze_required lists an unknown risk flag: $flag"
}
$qualityGate = Get-Content -LiteralPath (Join-Path $root 'hooks\quality-gate.ps1') -Raw -Encoding UTF8
Assert ($gate -match 'x_agent_workflow') 'task-gate.ps1 does not read the flag lists from the schema'
# The Stop hook and the close path must run the same rules. The hook owns Stop-event plumbing
# only; if it grows its own copy of the completion rules, the copy guarding `done` will drift.
Assert ($qualityGate -match 'task-gate\.ps1') 'quality-gate.ps1 does not delegate to the shared task gate'
Assert ($qualityGate -notmatch 'Reviewer result') 'quality-gate.ps1 has its own copy of the completion rules'
$closeTask = Get-Content -LiteralPath (Join-Path $root 'scripts\close-task.ps1') -Raw -Encoding UTF8
Assert ($closeTask -match 'task-gate\.ps1') 'close-task.ps1 does not run the shared task gate before closing'
Assert ($closeTask -match "Mode = 'Close'") 'close-task.ps1 does not use the Close-mode rules'

# `status: done` was the one task edit no gate inspected, because the Stop hook only ever
# resolves in_progress tasks. The write has to be blocked and routed through close-task.ps1.
$impactGuard = Get-Content -LiteralPath (Join-Path $root 'hooks\impact-guard.ps1') -Raw -Encoding UTF8
Assert ($impactGuard -match 'status:\[ \\t\]\*done') 'impact-guard.ps1 does not intercept a direct status: done write'
Assert ($impactGuard -match 'close-task\.ps1') 'impact-guard.ps1 does not point at the sanctioned close path'
Assert (($agents + $workflow) -match 'close-task\.ps1') 'runtime instructions do not route completion through close-task.ps1'

# Adversarial and mutation-check triggers move from prose into the schema so one list drives the
# role, the docs and the gate.
foreach ($listName in @('adversarial_required','mutation_check_required')) {
    Assert ($taskSchema.x_agent_workflow.$listName) "task schema does not publish x_agent_workflow.$listName"
    foreach ($flag in @($taskSchema.x_agent_workflow.$listName)) {
        Assert (@($taskSchema.properties.risk_flags.items.enum) -contains $flag) "$listName lists an unknown risk flag: $flag"
    }
}
foreach ($flag in $adversarialTriggers) {
    Assert (@($taskSchema.x_agent_workflow.adversarial_required) -contains $flag) "schema adversarial_required is missing the documented trigger: $flag"
}
Assert ($taskSchema.properties.PSObject.Properties.Name -contains 'roles_waived') 'task schema has no roles_waived escape hatch'
Assert (@($taskSchema.required) -notcontains 'roles_waived') 'roles_waived must stay optional'

# --- retrospective contract ---
# The one loop that points back at the framework instead of the change. Its vocabulary has to be
# stated once and read everywhere, for the same reason the adversarial triggers are: a category
# the role knows and the gate does not is a finding nobody can record.
$retroSchema = Get-Content -LiteralPath (Join-Path $root 'schemas\retro.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$retrospective = Get-Content -LiteralPath (Join-Path $root '.agents\agents\retrospective.md') -Raw -Encoding UTF8
$retroScript = Get-Content -LiteralPath (Join-Path $root 'scripts\retro.ps1') -Raw -Encoding UTF8
Assert (@($taskSchema.properties.change_kind.enum) -contains 'fix') 'task schema has no change_kind fix'
Assert (@($taskSchema.required) -notcontains 'change_kind') 'change_kind must stay optional in the schema; the gate is what requires it'
Assert ($taskSchema.x_agent_workflow.retrospective_required) 'task schema does not publish x_agent_workflow.retrospective_required'
foreach ($kind in @($taskSchema.x_agent_workflow.retrospective_required)) {
    Assert (@($taskSchema.properties.change_kind.enum) -contains $kind) "retrospective_required lists an unknown change_kind: $kind"
}
Assert ($task -match '(?m)^change_kind:') 'task template does not show change_kind in frontmatter'
Assert ($task.Contains('Retrospective result')) 'task template missing Retrospective result'
# A one-off must not rewrite the framework; only a repeat is evidence.
Assert ($retroSchema.x_agent_workflow.escalate_threshold -ge 2) 'a single occurrence would escalate to a framework change'
Assert (@($retroSchema.x_agent_workflow.gap_required) -contains 'regression') 'retro schema does not require a gap for a regression'
foreach ($category in @($retroSchema.properties.miss_category.enum)) {
    Assert ($retrospective -match [regex]::Escape($category)) "retrospective role does not list the miss category: $category"
    Assert ($workflowText -match 'retro\.ps1') 'workflow skill does not route findings through retro.ps1'
}
Assert ($gate -match 'miss_category') 'task-gate does not enforce the miss category vocabulary'
Assert ($gate -match 'retro\.schema\.json') 'task-gate does not read the retrospective vocabulary from the schema'
Assert ($retroScript -match 'retro\.schema\.json') 'retro.ps1 does not read its vocabulary from the schema'
Assert ($retrospective -match 'git blame|git log -L') 'retrospective role does not require locating the introducing commit'
Assert (($agents + $workflow) -match 'Retrospective|change_kind') 'runtime instructions never mention the retrospective loop'
# The role has to reach every platform, exactly like the adversarial round.
Assert (@($manifest.runtime) -contains 'agents/retrospective.md') 'managed runtime is missing agents/retrospective.md'
Assert (@($manifest.runtime) -contains 'schemas/retro.schema.json') 'managed runtime is missing schemas/retro.schema.json'
foreach ($platform in @('claude','codex','antigravity')) {
    Assert (@($manifest.platform_files.$platform) -match 'agent-workflow-retrospective') "platform $platform does not ship the retrospective agent"
}
Assert ($installer -match "'reviewer','adversarial','verifier','retrospective'") 'installer does not generate the retrospective agent for every platform'

# A role verdict is only meaningful against the diff it read; the gate recomputes the fingerprint.
Assert ($task -match 'diff_sha256') 'task template does not record the reviewed diff fingerprint'
Assert ($gate -match 'diff_sha256') 'task-gate does not compare the recorded diff fingerprint'
Assert ($workflowText -match 'worktree-fingerprint\.ps1') 'workflow skill does not tell the agent how to produce the fingerprint'
Assert ($task -match 'mutation check') 'task template has no mutation check line'
Assert ($gate -match 'mutation check') 'task-gate does not enforce the mutation check'

foreach ($section in @('Decomposition plan','Worker results','Delivery log','Integration verification','Parent task','File ownership')) {
    Assert ($task.Contains($section)) "Task template missing $section"
}
# file_ownership must use inline-array syntax; validate-task.ps1 cannot parse block arrays.
Assert ($task -match '(?m)^file_ownership: \[') 'task template does not show file_ownership as an inline array'

Assert ($installer -match "'worker'|worker\.md") 'installer does not install the canonical worker role'

# --- project docs contract ---
# Read-side enforcement (impact-guard.ps1 / task-gate.ps1) has to be real, not another instance
# of the pattern that already failed once here: project-architecture-index was written into
# SKILL.md and never executed by a single one of the four real projects that used this framework.
foreach ($path in @('.agents\skills\workflow\project-docs.md','scripts\project-doc.ps1')) {
    Assert (Test-Path -LiteralPath (Join-Path $root $path)) "Missing required file: $path"
}
$projectDocs = Get-Content -LiteralPath (Join-Path $root '.agents\skills\workflow\project-docs.md') -Encoding UTF8
Assert ($projectDocs.Count -le 100) 'workflow/project-docs.md exceeds 100 lines.'
$impactGuard = Get-Content -LiteralPath (Join-Path $root 'hooks\impact-guard.ps1') -Raw -Encoding UTF8
Assert ($workflowText -match 'project-doc\.ps1') 'workflow skill does not tell the agent to run project-doc.ps1'
Assert ($reviewer -match 'project-doc\.ps1') 'Reviewer does not look up project docs before building context'
# Verifier's whole value is independence from any written description of the system; feeding it
# project docs would anchor it on what the docs claim instead of what the entrypoint does.
Assert ($verifier -notmatch 'project-doc') 'Verifier must not read project docs (anchoring risk)'
Assert ($installer -match 'project-docs\.md') 'installer does not hard-link the canonical project-docs.md skill file'
Assert (@($manifest.runtime) -contains 'skills/workflow/project-docs.md') 'managed runtime is missing skills/workflow/project-docs.md'
Assert ($task -match 'Project docs') 'task template is missing the Project docs section'
Assert ($impactGuard -match 'Project docs') 'impact-guard.ps1 does not enforce the Project docs read: field'
Assert ($gate -match 'Project docs') 'task-gate.ps1 does not enforce the Project docs read: field'
# read: is unconditional (any code_change task); updated: is Close-only and conditional on
# change_kind or a documentation-triggering risk flag - both live in task-gate.ps1, the single
# source of completion rules, never duplicated into close-task.ps1 itself.
Assert ($gate -match 'updated:') 'task-gate.ps1 does not enforce the Project docs updated: field'
Assert ($gate -match "'feature', 'refactor'") 'task-gate.ps1 does not gate updated: on change_kind feature/refactor'
foreach ($flag in @('behavior_change', 'contract', 'schema', 'cross_feature')) {
    Assert ($gate -match [regex]::Escape($flag)) "task-gate.ps1 does not list '$flag' as a trigger for the updated: check"
}
Assert ($closeTask -notmatch 'Project docs') 'close-task.ps1 must not duplicate the Project docs check (task-gate.ps1 is the single source of completion rules)'
Assert ($workflowText -notmatch 'project-architecture-index') 'the dead project-architecture-index rule was not actually removed from the workflow skill'

Write-Output 'contract tests passed'
