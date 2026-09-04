---
description: Apply agent-workflow to the current programming task.
---

# /agent-workflow

Enter the managed workflow only when `managed_change: true`.

`managed_change` is based on actual behavioral, data, contract, security, deployment, delivery, runtime, or verification-integrity impact — not on whether the changed file is application source code.

Pure documentation, comments, read-only analysis, and safe test-only additions or refactors may bypass the workflow.

Config, script, CI/CD, migration, deployment, and test-integrity changes are classified by actual impact.

1. Read the project instructions and the `workflow` skill before making a managed change.
2. Load `clean-comments` only before modifying application source code logic; test code, docs, config, scripts, analysis, and planning do not trigger it.
3. If `managed_change: false`, remain in the main conversation and do not create a task.
4. If `managed_change: true`, create or resume the task and set `managed_change`, `code_change`, `task_type`, impact fields, `risk_flags`, `workflow_facts`, `workflow_mode: main`, and `workflow_request` according to the workflow skill.
5. Before modifying application source code, perform the project-doc lookup required by the project-docs skill. After the change, update or create docs only where the lookup indicates they are needed.
6. TDD is optional. Follow red → green → refactor only when the compiled workflow plan selects `tdd`.
7. Run relevant focused validation. For `code_change: true`, run the managed pre-review before final Review. Do not continue after a failed validation.
8. Execute only the capabilities selected by the compiled workflow plan, in their declared order. Record evidence through the runtime commands rather than manually editing task.json.
9. Run Retrospective only for a suspected regression, repeated fix, or explicit user request.
10. When completion criteria, validation, required evidence, and Review are complete, run `agent-workflow close-task`. `lifecycle.status` has no `done` value; the terminal state is `closed`.
11. Use `paused`, `blocked`, or `superseded` truthfully when the task cannot be completed.

Never commit, push, rebase, merge, or run another Git write without explicit user approval.
