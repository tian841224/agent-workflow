---
description: Apply agent-workflow v4 to the current programming task.
---

# /agent-workflow

1. Read the project instructions and `workflow` skill.
2. Resolve the project and worktree, then create or resume its single active `task.md`.
3. Set `code_change` explicitly and controlled `risk_flags`; request freeze only when a freeze-required flag applies.
4. Implement the smallest complete change without mandatory test-first development.
5. Run `~/.agent-workflow/runtime/scripts/pre-review.ps1` for the worktree; do not continue to review or completion after a failure.
6. Run Reviewer then Verifier only for `code_change: true`; run browser and other risk gates when their flags require them.
7. Mark the task `done`, or use `paused`, `blocked`, or `superseded` truthfully.

Never commit, push, or run another Git write without explicit user approval.
