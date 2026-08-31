# Elevated-only rules

This file only needs to be read for Elevated tasks, coordinator/worker, or tasks that explicitly enable the legacy completion gate; Standard tasks are not bound by any rule here, and skipping this file costs them nothing.

## Before creation and implementation

- Read the docs matched by the [project-docs skill](../project-docs/SKILL.md) lookup before reading the related code, and record those paths in the task's `## Project docs` `read:`.
- After reading the related code, before changing the first line of code, fill in the task's `Impact surface`: for every symbol, route, and event name to be changed, do a reverse search, record the search command and hit count, and attach `path:line` to every hit that needs judgment; list the actual trigger entrypoints, shared state, and unconfirmed nodes.
- Trace the execution path from the real entrypoints to all significant endpoints, covering error, retry, concurrency, and async branches (a Standard task only needs the execution path directly related to the points being created or changed).

## Before pre-review and roles

- Only coordinator/worker tasks, or tasks that explicitly enable the legacy completion gate, record `diff_sha256`; a regular task uses the last verification and Review result as the baseline.
- Before Review, the main agent recomputes the fingerprint with `~/.agent-workflow/runtime/agent_workflow.cmd worktree-fingerprint` to confirm the diff has stabilized; if a review result's `diff_sha256` no longer matches the current state, Review must re-run.

## Completion

- Fill in the Reviewer result with its own `diff_sha256` and the `independence` status.
- Run `~/.agent-workflow/runtime/agent_workflow.cmd close-task` to re-run the full legacy completion gate; the main agent must not decide completion criteria on its own and set `status: done` directly.
