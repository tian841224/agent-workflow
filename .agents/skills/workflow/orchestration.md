# Parallel orchestration

`agent-workflow orchestrate` (protocol 3, the default) is the only control plane for independent
implementation workers. The retired protocol 2 phase tracker cannot create or advance state; only
`--protocol 2 --action Read` of a leftover state file remains.

## Worthwhile before eligible

Eligibility is a safety gate, not a reason to parallelize. Use a batch only when there are at least
two work packages and each one carries enough implementation and validation work to outweigh
worktree setup, handoff, `Collect`／`Integrate`／`Apply`, and the parent's final validation.
Otherwise run ordered slices in the parent task. This is a coordinator judgement; it adds no plan
field.

## Eligibility

The coordinator may prepare one batch only when there are at least two workers, every worker has a
non-empty goal, completion criterion, and `file_ownership`, ownership prefixes do not overlap, no
worker depends on another worker's unfinished output, and no shared persistent state is written by
more than one worker. Shared integration files stay with the coordinator. The coordinator rejects
an ineligible plan before creating worktrees.

The plan is a JSON object passed with `--plan-path`:

```json
{
  "repo_root": "C:/repo",
  "parent_task_path": "C:/state/projects/p/tasks/parent/task.json",
  "max_workers": 3,
  "workers": [
    {"id":"api","goal":"...","completion_criteria":"...","file_ownership":["src/api"]},
    {"id":"ui","goal":"...","completion_criteria":"...","file_ownership":["src/ui"]}
  ]
}
```

`has_order_dependency: true` and `shared_persistent_state: true` are explicit rejection signals.
The parent task remains the authority for classification, lifecycle, evidence, reviewer, and
closure. A child task inherits the parent's intent text and intent approval when present, adds a
worker-assignment section, and receives the worker's ownership boundary.

## One-shot protocol

`Prepare` captures the complete current worktree, including dirty and untracked files, through a
temporary `GIT_INDEX_FILE` and an internal snapshot commit. It creates one detached worktree per
worker, one child `task.json` plus `execution-packet.json` per worker, and a version 3 state file
under `<state-root>/orchestration/v3/<id>`. The parent fingerprint is recorded after setup, so
creating linked worktrees does not appear as a parent edit.

```text
orchestrate --protocol 3 --action Assess --id <id> --plan-path <plan> [--repo-root <repo>]
orchestrate --protocol 3 --action Prepare --id <id> --state-root <root> --plan-path <plan>
orchestrate --protocol 3 --action Bind --id <id> --worker-id <worker> --run-id <run> --platform <platform> --workspace <worktree>
worker-check --assignment-path <execution-packet.json> --cwd <worktree>
worker-exec --assignment-path <execution-packet.json> --cwd <worktree> -- <command> [args...]
orchestrate --protocol 3 --action Collect --id <id> --worker-id <worker> --result-path <result.json>
orchestrate --protocol 3 --action Integrate --id <id>
orchestrate --protocol 3 --action Apply --id <id>
orchestrate --protocol 3 --action Fail --id <id> --reason <reason>
orchestrate --protocol 3 --action Cleanup --id <id>
```

The host platform dispatches the native Claude, Codex, or Antigravity worker after `Prepare` and
records its stable `run_id` with `Bind`. `worker-check` is fail-closed on the exact assigned cwd
and non-empty ownership. `worker-exec` runs a command without a shell and returns exit code plus an
output digest; it does not grant Git-write authority.

`Collect` accepts only `completed`, `blocked`, `failed`, or `cancelled`. A completed result is
converted into an immutable path/content artifact and checked against `file_ownership`; a failed
or blocked result is retained as rejected evidence. A result for a different `run_id` or attempt
is rejected. `Integrate` applies all collected artifacts to a fresh detached worktree from the
same snapshot and fails on path conflicts. `Apply` first compares the parent workspace fingerprint
with the value recorded by `Prepare`; any parent edit blocks the apply. It then copies only the
verified integrated artifacts into the parent worktree. `Retry` advances one worker attempt after a
non-completed result. `Recover` reports missing worktrees or invalid persisted statuses. `Cancel`
and `Cleanup` preserve the state journal and remove only registered protocol worktrees.

The state machine is:

```text
prepared -> executing -> collecting -> integrating -> applied -> cleaned
    |            |             |             |
    +------------+-------------+-------------+--> cancelled / failed
```

All state updates use the runtime JSON lock. `schemas/orchestration.schema.json` is the state
authority; `schemas/cli-output.schema.json` defines the command output shapes.

## After Apply

The protocol's responsibility ends at `Apply` (then `Cleanup`). The parent returns to its one
finalization flow in [evidence.md](evidence.md): final evidence, the Reviewer when selected, then
`close-task`, which evaluates the gate itself. Worker receipts never replace parent evidence.

## Ownership and recovery

`file_ownership` is a hard write boundary. A worker that needs another path stops and reports the
path; the coordinator widens the plan and starts a new attempt. No worker commits, branches,
rebases, merges, or edits another worktree. If `Integrate` finds a duplicate path, the batch stays
recoverable and the coordinator must split ownership before retrying. If `Apply` detects parent
drift, the coordinator preserves the artifacts, reviews the new parent diff, and starts a fresh
batch rather than overwriting the user's edit.

The protocol provides deterministic local orchestration and cross-platform assignment contracts;
native platform dispatch and remote/installed runtime verification remain outside this repository's
local test proof.
