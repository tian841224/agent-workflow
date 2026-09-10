# Parallel orchestration

`agent-workflow orchestrate` is Experimental. It is currently a phase-state prototype only.

## Current runtime behavior

The runtime tracks:

```text
planned -> split -> executing -> integrating -> integrated -> cleaned
```

Any phase before `integrated` may transition to `failed`, and `failed` transitions to `cleaned`.

Read-only actions (`Status`, `Assess`, `Read`) work without enabling experimental mutations. Every
state-mutating action requires `AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1` and uses a phase name:
`Init`, `StartExecution`, `Integrate`, `Apply`, `Fail`, `Cleanup`. These describe phase transitions,
not a worker protocol.

## Not implemented

The runtime implements none of the following, so none of them are part of the supported workflow
contract: automatic worker dispatch, worker-level lifecycle state, worker completion aggregation,
detached worktree creation, dirty-worktree snapshots, `GIT_INDEX_FILE` snapshotting, patch
collection, patch integration, patch application, worker timeout handling, retry scheduling, and
multi-worker success/failure accounting.

## Normal workflow

Sequential execution is the default. When the host platform provides native isolated sub-agents, the
main conversation may parallelize manually, but only when there are at least two independent work
items, file ownership does not overlap, no worker depends on another worker's unfinished change,
shared integration points remain owned by the coordinator, and each worker executes in its own
isolated worktree.

The coordinator owns: whether to split, creating or selecting isolated worktrees, creating worker
tasks, assigning file ownership, building each worker's ExecutionPacket, dispatching each worker
through the host platform, collecting worker results, integrating the changes, final validation,
Reviewer, task-gate, and closing the task. Orchestration lifecycle actions stay with the coordinator.

Worker handoffs should reference the ExecutionPacket and shared evidence map instead of copying their
procedure text. A completion message carries changed paths, local validation, blockers, and any new
impact or test gap; unchanged context is omitted so the coordinator can integrate from one source.

`file_ownership` is a hard boundary, not a review filter: any path changed outside it fails the gate as an
ownership violation. A delivery that legitimately reaches further needs the owner widened and its impact
re-confirmed, so assign each worker the scope its sub-task actually needs.

## Worker execution

Each worker receives one ExecutionPacket (`agent-workflow execution-packet`), containing intent
(Goal, Scope, Completion criteria), classification, selected capabilities and steps, procedure
pointers, repo root, file ownership, base commit when available, required evidence, and plan hash and
revision. Worker behavior is defined by [worker.md](../../agents/worker.md).

## Future activation rule

Automatic orchestration becomes a supported workflow only once all of the following exist:

1. worker-level state rather than reusing batch phase as worker state
2. at-least-two-worker acceptance tests
3. isolated worktree creation or verified host-native worktree binding
4. deterministic collect / integrate / apply behavior
5. worker failure and cleanup handling
6. concurrent worker completion without lost updates
7. integration conflict handling
8. Windows / Linux / macOS integration tests
9. a schema-defined worker dispatch / result contract
10. package-smoke verification for the complete orchestration path

Until then, this document describes capability status and safe manual parallelism.
