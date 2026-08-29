---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: <true | false>
workflow_mode: main
task_type: <fix | feature | refactor | chore | schema | migration | config | docs | investigation>
change_kind: <fix | feature | refactor | chore; required when code_change: true>
risk_flags: []
impact_scope: <file | module | multi_module | cross_project>
impact_effect: <none | local_behavior | shared_behavior | schema | data | contract | destructive>
impact_confidence: <high | medium | low>
complexity_hint: []
workflow_request: []
workflow_facts: <JSON object of declared facts; only affects which steps are selected within each capability already chosen in workflow_request, does not affect whether a capability itself is selected>
created_at: <ISO-8601>
updated_at: <ISO-8601>
frozen_at:
independence: native
---

<!-- Frontmatter field notes (only non-obvious rules listed; see schemas/workflow-policy.json for the rest):
workflow_request: may be empty, but the reason must be explained in Impact surface; whether a capability is selected is determined solely by this field.
workflow_facts: only affects which steps appear within an already-selected capability, not whether the capability is selected;
           an undeclared fact always keeps that step (unknown does not mean "not needed").
frozen_at: required as ISO-8601 when a freeze-required flag is hit — confirm the goal, non-goals, and completion criteria
           with the user first, then fill this in. The task gate checks the field at Stop/Close; it is not a per-tool write hook.
stop_reason: required when status changes to paused or blocked; if left blank, the next Stop in the same worktree will prompt once.
roles_waived: can only be written via waive-roles --reason '<reason>' --confirmed-by-user; direct edits are not a valid waiver
and will not satisfy the completion gate.
independence: defaults to native, checked only for coordinator/worker tasks or tasks with the legacy completion gate enabled;
           if a native role fails to load, or the main agent fills in a role section on its behalf, this must be honestly recorded as degraded — the close gate rejects unwaived degraded tasks.
-->

# <Task title>

## Goal

<What needs to be accomplished or confirmed>

## Scope

<Which behaviors will be modified/reviewed/verified; what is out of scope>

## Review round

- round: 1
<!-- The following four delta lines are only required for round >= 2; omit for round 1:
- prior findings: <specific conclusions from the previous Reviewer/Adversarial/Verifier round>
- fix delta: <what was actually changed in this round relative to the previous one>
- impact delta: <new callers/affected nodes relative to the previous round, or none>
- validation delta: <new targeted validation relative to the previous round, or none>
-->
- unverified nodes: <fill "none" for non-Elevated tasks; for Elevated tasks fill "see Impact surface" to avoid duplicate recording below>

## Completion criteria

- [ ] Expected behavior or review goal completed
- [ ] Relevant validation passed

## Validation results

- pre-review: <PASS | FAIL | SKIP>
- validation profile: <focused | affected | regression | full>
- changed paths: <repo-relative paths passed to validation, or none>
- command: <actual command>
- checks: <items executed and their results>
- skip reason: <fill only when SKIP>
- limitations: <unverified limitations; "none" if none>
- mutation check: <required as PASS or SKIP for financial/data_write: break the critical logic, confirm the guarding test fails red, then restore>
- mutation reason: <fill only when mutation check is SKIP>

<!-- Add only when memory was actually written to:
## Knowledge result

- updated: <entry-id>
-->

<!-- Add for freeze-required tasks:
## Non-goals and compatibility
## Current state and impact
## Decision and tradeoffs
## Boundary and error paths
## Acceptance cases

| ID | Scenario | Expected result | Verification method |
|---|---|---|---|

## User confirmation
-->

<!-- Add for Elevated code tasks (Project docs' "read" and Impact surface must be filled in before touching code):
## Project docs
- read: <doc paths matched and read via project-doc --action Lookup, comma-separated; if the project has no docs yet, fill "none - reason">
- updated: <doc paths updated or confirmed in this task, comma-separated; if none, fill "none - reason" (close-task.py checks this line when change_kind is feature/refactor, or when risk_flags hits behavior_change/contract/schema/cross_feature)>

## Impact surface
- Callers: <reverse-search command and hit count; hits needing judgment listed individually as path:line>
- Entry points: <HTTP/cron/MQ/CLI/frontend; "none" if none>
- Shared state: <other flows sharing the same table/redis key/global variable; "none" if none>
- Unconfirmed nodes: <nodes that could not be fully traced and why; "none" if none (the Review round's unverified nodes field references this directly, do not duplicate)>

## Execution path and regression evidence
<Entry point > upstream > modification point > downstream endpoint; list important error/retry/concurrency/async branches and validation evidence>

## Reviewer result (fill in only when `workflow_request` selects reviewer)
- result: <PASS | FAIL>
- findings: <none, or one line per blocker with path, symbol/hunk, trigger, impact, minimal fix>

## Adversarial result (fill in only when `workflow_request` selects adversarial)
- result: <PASS means "attempted to refute, refutation did not hold">
- Provenance: <PASS>
- Pattern fan-out: <PASS>
- Engine semantics: <PASS>
- Cross-round accumulation: <PASS>

## Verifier result (fill in only when `workflow_request` selects verifier)
- PASS

## Retrospective result (only added for suspected regressions, repeated fixes for the same issue, or on user request)
- introduced_by: <commit sha that introduced the defect, or unknown - which searches were run>
- classification: <regression | pre_existing | external>
- miss_category: <required only when regression; a category from schemas/retro.schema.json, or "other" when none of them fits — then describe the actual gap in gap_evidence>
- gap_evidence: <required only when regression: which section of which task, or which gate failed to catch it; include task id or path:line>
- framework_change: <required only when regression: recorded:<retro-id>, or not_needed - reason>
- summary: <a one-line summary understandable on its own>
- occurrences: <fill only when regression: the cumulative count of similar occurrences returned by retro --action Record>
-->

<!-- Each evidence capability selected in workflow_request gets its own section; section titles follow the `section`
     field in schemas/workflow-policy.json (data_impact and contract_review share "Contract and data impact",
     execution_path_review and regression_validation share "Execution path and regression evidence").
     Only write the steps actually selected within that capability (which steps are selected is determined by
     the same policy's steps[].when, driven by impact_scope/impact_effect/change_kind/risk_flags/workflow_facts),
     one line per step as `- <step id>: <conclusion and evidence>`; unselected steps do not need to be filled in and are not checked.
-->

<!-- Other conditional sections:
behavior_change/ui: ## Acceptance cases
cross_feature/migration/irreversible: ## Implementation sequence (implementation order, dependencies, and rollback points)
ui: ## Browser verification
change_kind: refactor: ## Behavior invariants and before-after evidence
workflow_request is empty: ## Impact surface is required, explaining why this task was judged not to need any capability
-->

<!-- Add for coordinator tasks (also add subtask_role: coordinator, integration_status: pending to frontmatter):
## Decomposition plan
- Reason for splitting and each worker's scope
- Split plan JSON path and split-plan.py's eligibility determination

## Worker results
- Each worker's status, validation results, fix-forward history, and Manual handoff information

## Delivery log
- Each patch, ownership/overlap findings, apply results
- Conflict merges: conflicting paths, merge tradeoffs, questions asked to the user and their answers
- Items pending user decision

## Integration verification
- Post-integration pre-review, affected test set, Reviewer and Verifier evidence
-->

<!-- Add for worker tasks. Add the following five fields to frontmatter (file_ownership must be an inline array):
subtask_role: worker
parent_task_id: <coordinator-task-id>
base_commit: <40-hex; worktree baseline, also the Reviewer's diff baseline>
file_ownership: [src/payment/, tests/payment/]
delivery_status: pending

## Parent task
- coordinator task id and base_commit

## File ownership
- List of repo-relative prefixes matching frontmatter's file_ownership, with reasons
- When files outside the scope are needed: ownership_request and the evidence at the point it stopped
-->
