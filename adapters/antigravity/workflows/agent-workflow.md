---
description: Apply agent-workflow v4 to the current programming task.
---

# /agent-workflow

Only invoke this workflow when the task modifies source code, executable scripts, or test code. For non-code tasks, stay in the single main conversation: do not create a task, load this workflow, or invoke Reviewer/Verifier.

1. Read the project instructions and `workflow` skill.
2. Resolve the project and worktree, then create or resume its single active `task.md`.
3. Set `code_change` explicitly and controlled `risk_flags`; request freeze only when a freeze-required flag applies.
4. Implement the smallest complete change without mandatory test-first development.
5. Run `~/.agent-workflow/runtime/scripts/pre-review.ps1` for the worktree; do not continue to review or completion after a failure.
6. For `code_change: true`, have Reviewer and Verifier trace the complete execution path from entrypoint through the changed code to downstream effects and important error/retry/concurrency branches; run Reviewer then Verifier. Run browser and other risk gates when their flags require them.
7. Mark the task `done`, or use `paused`, `blocked`, or `superseded` truthfully.

Never commit, push, or run another Git write without explicit user approval.
