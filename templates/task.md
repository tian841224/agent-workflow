<!-- This file only holds the human-readable intent (Goal/Scope/Completion criteria and the
     evidence sections below). `id`/`project_id`/`worktree_id`/`code_change`/`managed_change`/`workflow_mode`/
     `task_type`/`risk_flags`/`impact_scope`/`impact_effect`/`impact_confidence`/
     `workflow_request`/`workflow_facts`/`workflow_decision`/`model_profile`/`independence`/
     `intent_approval`/`lifecycle.stop_reason` all live in the sibling `task.json`
     (schemas/task.schema.json), written only through `agent-workflow task-init` / `task-write`.
     Field notes (only non-obvious rules listed; see schemas/workflow-policy.json for the rest):
workflow_request: may be empty, but a capability whose require_when matches is added by the runtime regardless; the only way to drop one is an explicit waiver.
workflow_facts: only affects which steps appear within an already-selected capability, not whether the capability is selected;
           an undeclared fact always keeps that step (unknown does not mean "not needed").
intent_approval: required when a freeze-required flag is hit — confirm the goal, non-goals, and completion criteria with the
           user first, then run `agent-workflow approve-intent --confirmed-by <who> --as-user`; it binds only this file's
           Goal/Scope/Completion criteria sections, so editing other sections afterwards does not invalidate it.
lifecycle.stop_reason: required when status changes to paused or blocked; if left blank, the next Stop in the same worktree will prompt once.
waivers: written only by `agent-workflow waive --requirement-id <id> --confirmed-by-user '<text>'`; a waiver binds the plan's
           plan_hash, so it lapses the moment the task's classification changes. Direct edits are not a valid waiver.
independence: defaults to native, checked only for coordinator/worker tasks or tasks with the legacy completion gate enabled;
           if a native role fails to load, or the main agent fills in a role section on its behalf, this must be honestly recorded as degraded — the close gate rejects unwaived degraded tasks.
-->

# <Task title>

## Goal

<What needs to be accomplished or confirmed>

## Scope

<Which behaviors will be modified/reviewed/verified; what is out of scope>

<!-- Add for freeze-required tasks. This lives inside Scope, not beside it, because intent_hash
covers Goal/Scope/Completion criteria: a non-goal recorded in its own top-level section could be
rewritten after approval without invalidating the approval the user gave.
### Non-goals and compatibility
<What this task will deliberately not do, and what must keep working unchanged>
-->

## Review round

- round: 1
<!-- The following five lines are only required for round >= 2; omit for round 1:
- prior findings: <specific conclusions from the previous review round>
- fix delta: <what was actually changed in this round relative to the previous one>
- impact delta: <new callers/affected nodes relative to the previous round, or none>
- validation delta: <new targeted validation relative to the previous round, or none>
- cause: <review-cause id from review-cause --action Record, or "none - reason">
-->
- unverified nodes: <fill "none" for non-Elevated tasks; for Elevated tasks fill "see Impact surface" to avoid duplicate recording below>

## Completion criteria

- [ ] Expected behavior or review goal completed
- [ ] Relevant validation passed

<!-- Add for freeze-required tasks. Inside Completion criteria for the same reason as Non-goals:
the cases the user accepted are part of what they approved, so they have to be inside intent_hash.
### Acceptance cases

| ID | Scenario | Expected result | Verification method |
|---|---|---|---|
-->

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

<!-- Add for freeze-required tasks. Non-goals and Acceptance cases are NOT here: they belong inside
Scope and Completion criteria respectively, so intent_hash covers them (see above). These four are
planning and evidence prose — revising them after approval is expected and does not reopen the freeze:
## Current state and impact
## Decision and tradeoffs
## Boundary and error paths
## User confirmation
-->

<!-- Add for Elevated code tasks ("read" and Impact surface must be filled in before touching code;
"updated" alone is also required on every Standard task via templates/task-minimal.md):
## Project docs
- read: <doc paths matched and read via project-doc --action Lookup, comma-separated; if the project has no docs yet, fill "none - reason">
- updated: <doc paths created or updated by the post-change sync step, comma-separated; if the sync step found no doc needed changing, fill "none - reason">

## Impact surface
- Callers: <reverse-search command and hit count; hits needing judgment listed individually as path:line>
- Entry points: <HTTP/cron/MQ/CLI/frontend; "none" if none>
- Shared state: <other flows sharing the same table/redis key/global variable; "none" if none>
- Unconfirmed nodes: <nodes that could not be fully traced and why; "none" if none (the Review round's unverified nodes field references this directly, do not duplicate)>

## Execution path and regression evidence
<Entry point > upstream > modification point > downstream endpoint; list important error/retry/concurrency/async branches and validation evidence>

## Reviewer result (fill in only when reviewer is a selected capability — required by the compiled plan, requested in `workflow_request`, or both)
- result: <PASS | FAIL>
- findings: <none, or one line per blocker with path, symbol/hunk, trigger, impact, minimal fix>

## Retrospective result (only added for suspected regressions, repeated fixes for the same issue, or on user request)
- introduced_by: <commit sha that introduced the defect, or unknown - which searches were run>
- classification: <regression | pre_existing | external>
- miss_category: <required only when regression; a category from schemas/retro.schema.json, or "other" when none of them fits — then describe the actual gap in gap_evidence>
- gap_evidence: <required only when regression: which section of which task, or which gate failed to catch it; include task id or path:line>
- framework_change: <required only when regression: recorded:<retro-id>, or not_needed - reason>
- summary: <a one-line summary understandable on its own>
- occurrences: <fill only when regression: the cumulative count of similar occurrences returned by retro --action Record>
-->

<!-- Each selected evidence capability gets its own section. "Selected" is required ∪ workflow_request —
     a capability the compiled plan requires has to be filled in even though nobody requested it; run
     `agent-workflow workflow-plan --task-path <path>` to see the selected list. Section titles follow the `section`
     field in schemas/workflow-policy.json (data_impact and contract_review share "Contract and data impact",
     execution_path_review and regression_validation share "Execution path and regression evidence").
     Only write the steps actually selected within that capability (which steps are selected is determined by
     the same policy's steps[].when, driven by impact_scope/impact_effect/task_type/risk_flags/workflow_facts),
     one line per step as `- <step id>: <conclusion and evidence>`; unselected steps do not need to be filled in and are not checked.
-->

<!-- Other conditional sections:
behavior_change/ui: ### Acceptance cases (inside ## Completion criteria)
cross_feature/migration/irreversible: ## Implementation sequence (implementation order, dependencies, and rollback points)
ui: ## Browser verification
task_type: refactor: ## Behavior invariants and before-after evidence
workflow_request is empty: ## Impact surface is required, explaining why this task was judged not to need any capability
-->

<!-- Add for coordinator tasks (also add subtask_role: coordinator, integration_status: pending to task.json):
## Decomposition plan
- Reason for splitting and each worker's scope
- Split plan JSON path and `agent-workflow split-plan`'s eligibility determination

## Worker results
- Each worker's status, validation results, fix-forward history, and Manual handoff information

## Delivery log
- Each patch, ownership/overlap findings, apply results
- Conflict merges: conflicting paths, merge tradeoffs, questions asked to the user and their answers
- Items pending user decision

## Integration verification
- Post-integration pre-review, affected test set, and Reviewer evidence
-->

<!-- Add for worker tasks. Add the following five fields to task.json (file_ownership must be an array):
subtask_role: worker
parent_task_id: <coordinator-task-id>
base_commit: <40-hex; worktree baseline, also the Reviewer's diff baseline>
file_ownership: [src/payment/, tests/payment/]
delivery_status: pending

## Parent task
- coordinator task id and base_commit

## File ownership
- List of repo-relative prefixes matching task.json's file_ownership, with reasons
- When files outside the scope are needed: ownership_request and the evidence at the point it stopped
-->
