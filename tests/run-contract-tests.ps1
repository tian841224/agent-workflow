$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$agents = Get-Content -LiteralPath (Join-Path $root 'AGENTS.md') -Encoding UTF8
$workflow = Get-Content -LiteralPath (Join-Path $root 'skills\workflow\SKILL.md') -Encoding UTF8
Assert ($agents.Count -le 40) 'AGENTS.md exceeds 40 lines.'
Assert ($workflow.Count -le 200) 'workflow/SKILL.md exceeds 200 lines.'
Assert (-not (($agents + $workflow) -match 'L0|輕軌|標準軌|重軌|test-driven-development')) 'v3 tracks or TDD remain in runtime context.'
Assert (($agents + $workflow) -match 'pre-review') 'pre-review is missing from runtime instructions.'
Assert ($workflow -match '~/.agent-workflow/runtime/scripts/pre-review.ps1') 'workflow does not use the managed pre-review runtime path.'

foreach ($path in @(
    'agents\reviewer.md','agents\verifier.md','hooks\git-guard.ps1','hooks\quality-gate.ps1',
    'scripts\project-resolver.ps1','scripts\knowledge.ps1','scripts\pre-review.ps1','scripts\validate-task.ps1','templates\task.md','schemas\project.schema.json',
    'schemas\knowledge.schema.json','schemas\task.schema.json','schemas\import-manifest.schema.json'
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
$reviewer = Get-Content -LiteralPath (Join-Path $root 'agents\reviewer.md') -Raw -Encoding UTF8
foreach ($dimension in @('Architecture consistency','Code quality and conventions','Data consistency','Security','Risk and compatibility','Performance')) {
    Assert ($reviewer.Contains($dimension)) "Reviewer missing dimension: $dimension"
}
$taskSchema = Get-Content -LiteralPath (Join-Path $root 'schemas\task.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert (@($taskSchema.required) -contains 'code_change') 'task schema does not require code_change'
Assert ($taskSchema.properties.code_change.type -eq 'boolean') 'task schema code_change is not boolean'
$workflowText = $workflow -join "`n"
Assert ($workflowText -match 'code_change: true') 'workflow does not define the code-change role gate'
Assert ($workflowText -match 'code_change: false') 'workflow does not define the non-code role bypass'
Assert ($workflowText -notmatch '強制 Reviewer → Verifier') 'risk flags still force Reviewer and Verifier'
$manifest = Get-Content -LiteralPath (Join-Path $root 'adapters\managed-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert (@($manifest.runtime) -contains 'scripts/pre-review.ps1') 'managed runtime is missing pre-review.ps1'
foreach ($removed in @('acceptance','templates/spec.md','templates/checklist.md','templates/plan.md','templates/mini-spec.md')) {
    Assert (-not (@($manifest.runtime) -match [regex]::Escape($removed))) "legacy artifact returned to runtime manifest: $removed"
}
Write-Output 'contract tests passed'
