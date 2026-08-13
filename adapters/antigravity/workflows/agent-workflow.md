---
description: Apply agent-workflow v4 to the current programming task.
---

# /agent-workflow

Only invoke this workflow when the task modifies source code logic, executable scripts, or test code. For comment-only, config, docs, or other non-logic tasks, stay in the single main conversation: do not create a task, load this workflow, or invoke Reviewer/Verifier.

1. Read the project instructions and `workflow` skill.
2. Resolve the project and worktree, then create or resume its single active `task.md`.
3. Set `code_change` explicitly, set `change_kind` (`fix | feature | refactor | chore`) whenever `code_change` is true, and add controlled `risk_flags`; request freeze only when a freeze-required flag applies.
4. For `code_change: true`, before reading the code run `~/.agent-workflow/runtime/scripts/project-doc.ps1 -Action Lookup -Paths '<paths>'`, read the matched docs, and record them under `## Project docs` - `read:` (or `none - <reason>` when the project has none yet). Unfilled, placeholder, or a path that does not exist is denied by `impact-guard` before any code edit.
5. Follow TDD: write a failing test that covers the expected behavior, implement the smallest change to pass it, then refactor as needed.
6. Run `~/.agent-workflow/runtime/scripts/pre-review.ps1` for the worktree; do not continue to review or completion after a failure.
7. For `code_change: true`, run `~/.agent-workflow/runtime/scripts/worktree-fingerprint.ps1` before each role and record the value it returns in that role's result section. Have Reviewer and Verifier trace the complete execution path from entrypoint through the changed code to downstream effects and important error/retry/concurrency branches; run Reviewer, then Adversarial when a high-cost risk flag applies, then Verifier. Run browser and other risk gates when their flags require them.
8. If a role cannot be loaded or never reports, run the installer `Repair` once, then mark the task `blocked`. Do not stand in for the role and close the task.
9. For `change_kind: fix`, run Retrospective before closing: it decides whether an earlier change introduced the defect and, if so, which gate let it through. Record its six lines under `## Retrospective result`, and for a regression run `~/.agent-workflow/runtime/scripts/retro.ps1 -Action Record`. When it reports `escalate: true`, propose the concrete framework change to the user instead of applying it yourself.
10. Close with `~/.agent-workflow/runtime/scripts/close-task.ps1`, which re-runs the full gate before writing `done`; editing `status: done` directly is denied. Use `paused`, `blocked`, or `superseded` truthfully.

Never commit, push, or run another Git write without explicit user approval.
