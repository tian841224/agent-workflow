<!-- Human-readable intent only. Classification and lifecycle live in the sibling task.json
     (schemas/task.schema.json), written only through the agent-workflow CLI. Use templates/task.md
     when an evidence capability is selected, or for coordinator/worker tasks. -->

# <task title>

## Goal

<!-- What outcome must this task deliver? -->

## Scope

<!-- Included paths and explicit non-goals. -->

## Review round

- round: 1
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
