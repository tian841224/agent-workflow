---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: true
task_type: <fix | feature | refactor | chore | schema | migration | config | docs | investigation>
change_kind: <fix | feature | refactor | chore>
risk_flags: []
impact_scope: <file | module | multi_module | cross_project>
impact_effect: <none | local_behavior | shared_behavior | schema | data | contract | destructive>
impact_confidence: <high | medium | low>
workflow_request: []
workflow_profile:
workflow_facts:
workflow_decision:
created_at: <ISO-8601>
updated_at: <ISO-8601>
frozen_at:
---

# <task title>

## Goal

<!-- What outcome must this task deliver? -->

## Scope

<!-- Included paths and explicit non-goals. -->

## Review round

- round: 1
- prior findings: none
- fix delta: none
- impact delta: <direct callers and new affected nodes, or none>
- validation delta: <new focused validation, or none>
- unverified nodes: none

## Completion criteria

- [ ] <observable result>
- [ ] <relevant regression or acceptance case>

## Validation results

- pre-review: <PASS | FAIL | SKIP + reason>
- validation profile: <focused | affected | regression | full>
- changed paths: <repo-relative paths passed to validation, or none>
- commands: <actual targeted commands>
- checks: <actual results>
- limitations: <unverified behaviour or none>

## Reviewer result

- result: <PASS | FAIL>
- findings: <none or concise findings>
- Architecture consistency: <PASS>
- Code quality and conventions: <PASS>
- Data consistency: <PASS | N/A>
- Security: <PASS | N/A>
- Risk and compatibility: <PASS>
- Performance: <PASS | N/A>
- Flow and impact completeness: <PASS>
- Failure modes and observability: <PASS>

## Verifier result

- result: <PASS | FAIL>
- evidence: <real entrypoint and relevant verification>

<!--
Keep only the role sections the planner actually selected: workflow_decision.selected is
the single source of truth, and the gate checks nothing else. A task may legitimately run
verifier alone, or adversarial + verifier without reviewer.

workflow_request is a floor, not a profile: list the capabilities that must run regardless
of the plan (for example [verifier]). workflow_facts is declared by the agent and can only
add work -- suppressing a capability always needs observed evidence from the worktree.

Use templates/task.md when the plan selects evidence capabilities (their step lines live
there), or for coordinator/worker tasks.
Add Retrospective result only for a suspected regression, repeated fix, or user request.
-->
