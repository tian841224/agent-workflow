---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: true
change_kind: <fix | feature | refactor | chore>
risk_flags: []
created_at: <ISO-8601>
updated_at: <ISO-8601>
frozen_at:
---

# <task title>

## Goal

<!-- What outcome must this task deliver? -->

## Scope

<!-- Included paths and explicit non-goals. -->

## Completion criteria

- [ ] <observable result>
- [ ] <relevant regression or acceptance case>

## Validation results

- pre-review: <PASS | FAIL | SKIP + reason>
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
Use templates/task.md when the task is Elevated, coordinator/worker, or carries
data/contract/schema/financial/migration/irreversible risk that needs the extended gate.
Add Retrospective result only for a suspected regression, repeated fix, or user request.
-->
