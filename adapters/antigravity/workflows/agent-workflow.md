---
description: Apply agent-workflow v4 to the current programming task.
---

# /agent-workflow

Only invoke this workflow when the task modifies source code logic or test code. For comment-only, config, docs, script edits/operations, or other non-logic tasks, stay in the single main conversation: do not create a task, load this workflow, or invoke Reviewer/Verifier.

1. Read the project instructions and `workflow` skill.
2. For a Standard code task, create or resume the known `task.md` directly. Resolve project/worktree only for coordinator, worker, or Elevated legacy-gate tasks.
3. Set `code_change` explicitly, set `change_kind` (`fix | feature | refactor | chore`) whenever `code_change` is true, and add controlled `risk_flags`; request freeze only when a freeze-required flag applies.
4. For an Elevated task, before reading the code run `~/.agent-workflow/runtime/scripts/project-doc.py -Action Lookup -Paths '<paths>'` and record the matched docs under `## Project docs` - `read:`. Standard tasks use current code, callers, and tests without a mandatory project-doc lookup.
5. Follow TDD when adding or fixing testable behavior: write a failing test, implement the smallest change to pass it, then refactor as needed. Test-only or non-automatable changes record the alternative validation.
6. Run relevant tests and, for code tasks, the managed `pre-review.py`; do not continue to review or completion after a failure.
7. Run Reviewer then Verifier for every code task. Add Adversarial when a code task carries one of the six high-risk flags; add browser, mutation, full execution-path review, or fingerprint only when the task profile or risk flags require them.
8. If a role cannot be loaded or never reports, run the installer `Repair` once, then mark the task `blocked`. Do not stand in for the role and close the task.
9. Run Retrospective only for a suspected regression, repeated fix, or explicit request. Record its result and use `retro.py -Action Record` only for a confirmed regression.
10. Standard tasks may be marked `done` after completion criteria, validation, Reviewer, and Verifier are complete. Coordinator/worker or Elevated tasks use `close-task.py` for the full legacy gate. Use `paused`, `blocked`, or `superseded` truthfully.

Never commit, push, or run another Git write without explicit user approval.
