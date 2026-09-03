<!-- This file only holds the human-readable intent (Goal/Scope/Completion criteria and the
     sections below). `id`/`project_id`/`worktree_id`/`code_change`/`workflow_mode`/`task_type`/
     `risk_flags`/`impact_scope`/`impact_effect`/`impact_confidence`/`workflow_request`/
     `workflow_facts`/`model_profile`/`intent_approval` all live in the sibling `task.json`
     (schemas/task.schema.json), written only through `agent-workflow task-init` / `task-write`. -->

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

## Project docs

- updated: <doc paths created or updated by project-doc's post-change sync step, comma-separated; if the sync step found no doc needed changing, fill "none - reason">

## Validation results

- pre-review: <PASS | FAIL | SKIP + reason>
- validation profile: <focused | affected | regression | full>
- changed paths: <repo-relative paths passed to validation, or none>
- commands: <actual targeted commands>
- checks: <actual results>
- limitations: <unverified behaviour or none>

## Reviewer result

- result: <PASS | FAIL>
- findings: <none, or one line per blocker with path, symbol/hunk, trigger, impact, minimal fix>

<!--
Keep the Reviewer result section only when workflow_request selects reviewer: that list is
the complete and only source of truth, and the gate checks nothing else. A task may
legitimately request evidence capabilities alone, with no reviewer.

workflow_facts is declared by the agent; it decides which steps appear inside an
already-selected evidence capability and can produce deterministic capability suggestions
(see schemas/workflow-policy.json). Suggestions never replace the final workflow_request.

Use templates/task.md when workflow_request includes an evidence capability (their step
lines live there), or for coordinator/worker tasks.
Add Retrospective result only for a suspected regression, repeated fix, or user request.

Project docs' "updated:" line is required on every code-changing task, not just Elevated ones —
whether to read or write a doc stays a judgment call (see the project-docs skill's Lookup and
sync steps), but the outcome of that judgment must be recorded here so it is never silently
skipped. Elevated tasks additionally record "read:" (see templates/task.md) because they already
do a reverse-search-driven Impact surface; Standard tasks do not repeat that here.
-->
