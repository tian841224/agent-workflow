# Elevated-only rules

Read this only for Elevated tasks or coordinator/worker tasks. Standard tasks are not bound by any rule here, and skipping this file costs them nothing.

## Before creation and implementation

- Read the docs matched by the [project-docs skill](../project-docs/SKILL.md) lookup before reading the related code, and record those paths in the task's `## Project docs` `read:`.
- After reading the related code, before changing the first line of code, fill in the task's `Impact surface`: for every symbol, route, and event name to be changed, do a reverse search, record the search command and hit count, and attach `path:line` to every hit that needs judgment; list the actual trigger entrypoints, shared state, and unconfirmed nodes.
- Trace the execution path from the real entrypoints to all significant endpoints, covering error, retry, concurrency, and async branches (a Standard task only needs the execution path directly related to the points being created or changed).

## Before pre-review and roles

- Before Review, the main agent recomputes the fingerprint with `agent-workflow worktree-fingerprint` to confirm the diff has stabilized; `workspace_sha256` moving mid-review means the diff is still in flight, so Review waits rather than reviewing a moving target.
- Role evidence in `task.json` is scoped to the diff a review actually covered: record `reviewed_base`, `reviewed_paths` and the `reviewed_diff_sha256` returned by `agent-workflow worktree-fingerprint --base <sha> --paths <comma-separated paths>`. The gate recomputes that digest, so an edit outside the reviewed paths leaves the review valid while any change inside them requires a re-review. Run `agent-workflow task-gate --repo-root <repo>` only when you need its blocking details; `close-task` runs the same completion gate before writing `closed`. The task directory lives in the state root, not in the repo. `reviewed_paths` must cover every path changed since `reviewed_base`, renames and deletions included — a scope aimed at an untouched path would otherwise yield a digest that never goes stale.
- Declaring `file_ownership` declares a hard boundary, not a review filter: any path changed outside it fails the gate as an ownership violation, so a task whose delivery legitimately reaches further has to widen `file_ownership` (and re-confirm the impact) rather than leave the change unreviewed.

## Completion

- Fill in the Reviewer result with the review conclusion and record `independence` honestly: `native` when the role ran as its own agent, `degraded` when the main agent filled in a role section on its behalf. The runtime computes `reviewed_base`, `reviewed_paths`, `reviewed_diff_sha256`, and `delivery_hash`; do not copy those machine fields into task.md.
- Run `agent-workflow close-task` to re-run the completion gate; the main agent must not decide completion criteria on its own and edit `lifecycle.status` directly (there is no `done` value — `closed` is the only terminal status, and only `close-task` may write it).
