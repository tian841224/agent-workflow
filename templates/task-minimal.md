---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: true
workflow_mode: main
task_type: <fix | feature | refactor | chore | schema | migration | config | docs | investigation>
change_kind: <fix | feature | refactor | chore>
risk_flags: []
impact_scope: <file | module | multi_module | cross_project>
impact_effect: <none | local_behavior | shared_behavior | schema | data | contract | destructive>
impact_confidence: <high | medium | low>
complexity_hint: []
workflow_request: []
workflow_facts:
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
<!-- Only list dimensions actually checked (one line each, e.g. `- Security: PASS`).
Pick from: Architecture consistency, Code quality and conventions, Data consistency,
Security, Risk and compatibility, Performance, Flow and impact completeness,
Failure modes and observability. Skip anything not checked -- no need to report N/A. -->

## Verifier result

- result: <PASS | FAIL>
- evidence: <real entrypoint and relevant verification>

<!--
Keep only the role sections actually in workflow_request: that list is the complete and
only source of truth for which roles must run, and the gate checks nothing else. A task
may legitimately request verifier alone, or adversarial + verifier without reviewer.

workflow_facts is declared by the agent; it only decides which steps appear inside an
already-selected evidence capability (see schemas/workflow-policy.json), never which
capabilities are selected -- that is workflow_request alone.

Use templates/task.md when workflow_request includes an evidence capability (their step
lines live there), or for coordinator/worker tasks.
Add Retrospective result only for a suspected regression, repeated fix, or user request.
-->
