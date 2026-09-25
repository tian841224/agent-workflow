# Parallel orchestration

Read this when task-init returns `parallel_hint.candidate: true`. Experimental until it has run on a
real task. `agent-workflow orchestrate` (protocol 3) is the only control plane for parallel workers;
the parent task keeps classification, acceptance, Reviewer and closure.

## When to split

A split pays only when it clearly saves wall-clock time: every worker re-reads its context, so total
tokens go up. Ordered slices in the parent task ([elevated.md](elevated.md)) stay the default.

1. `parallel_hint.candidate` is true. Its `reasons` say why not when it is false; then stay sequential.
2. Write the split plan (below) and run `Assess`. It checks two things and recommends `parallel` only
   when both hold:
   - **eligible** (safe): at least two workers, disjoint `file_ownership`, `planned_files` inside each
     worker's ownership, `shared_files` inside nobody's ownership, and every parent acceptance case
     assigned exactly once — to one worker or to `coordinator_acceptance`.
   - **worthwhile** (worth it): each worker owns at least one acceptance case and at least
     `min_files_per_worker` (default 3) planned files, and the parent carries no risk flag that needs
     one ordered sequence (`migration`, `irreversible`, `schema`, `unclear_requirements`).
3. On `recommendation: parallel`, state in the progress message which cases and paths each worker
   owns, then follow `next`. On `sequential`, continue with ordered slices.

Antigravity has no native subagent, so its tasks always stay sequential.

## How to split

1. **By behavior first.** Group acceptance cases that can be verified independently; each group is one
   worker. Then find the directory prefixes that group changes; those are its `file_ownership`.
2. **Contracts before dispatch.** Shared types and interfaces, route or DI registration, index
   exports, configuration, lockfiles and migrations are `shared_files`. The coordinator writes them
   before `Prepare`; the snapshot carries them into every worktree, and workers build against them
   read-only.
3. **No waiting between workers.** When one group needs another's output, remove the dependency by
   writing the contract first; when that is impossible, keep those groups in ordered slices.
4. **Cross-worker cases stay with the parent.** An end-to-end case spanning several groups goes in
   `coordinator_acceptance` and runs after `Apply`.
5. **Two or three workers.** `max_workers` defaults to 3; more workers multiply context and
   integration cost faster than they save time.

```json
{
  "parent_task_path": "<parent task.json>",
  "repo_root": "<repo>",
  "max_workers": 3,
  "shared_files": ["src/types/order.ts", "src/routes.ts"],
  "coordinator_acceptance": ["AC5"],
  "workers": [
    {"id": "api", "goal": "...", "acceptance": ["AC1", "AC2"], "file_ownership": ["src/api/"], "planned_files": ["src/api/order.ts", "src/api/validate.ts", "src/api/order.test.ts"]},
    {"id": "ui", "goal": "...", "acceptance": ["AC3", "AC4"], "file_ownership": ["src/ui/order/"], "planned_files": ["src/ui/order/form.tsx", "src/ui/order/list.tsx", "e2e/order.spec.ts"]}
  ]
}
```

## Running a batch

Every action returns `next`; follow it. The sequence is:

```text
orchestrate --action Assess  --id <id> --plan-path <plan>
orchestrate --action Prepare --id <id> --plan-path <plan>
  dispatch all workers in one turn (below), then Bind each: --worker-id <w> --run-id <run> --platform <p>
orchestrate --action Collect --id <id> --worker-id <w>        (once per worker, as each reports)
orchestrate --action Integrate --id <id>
orchestrate --action Apply --id <id>
orchestrate --action Cleanup --id <id>
```

**Dispatch.** Send each worker only `Execute the assignment in <packet_path>`, all in the same turn:

- Claude: Agent tool, `subagent_type: agent-workflow-worker`, `run_in_background: true`.
- Codex: the spawn_agent tool with agent type `agent-workflow-worker`.

While workers run, the coordinator does non-overlapping work (for example the next shared contract or
the `coordinator_acceptance` test), leaving the parent worktree's delivered files unchanged: `Apply`
refuses a parent that changed since `Prepare`.

**What the runtime guarantees.**
- `Prepare` snapshots the dirty parent, creates one detached worktree per worker, and links the
  parent's ignored dependency directories (`node_modules`, `.venv`, `venv`, `vendor`) so tests run
  without reinstalling.
- `Collect` reads the worker's result file and its `worker-exec` receipts. A completed worker is
  rejected when it wrote outside its ownership or any assigned case has no passing receipt.
- `Integrate` applies every artifact to a fresh worktree and fails on a path changed by two workers.
- `Apply` copies the integrated delivery into the parent.
- `Fail`／`Cancel` end the batch and release the child tasks.

## Recovery

- **Rejected worker.** `Retry --worker-id <w>` starts a new attempt. When the rejection is an
  ownership request, first update that worker in the plan and pass `--plan-path`; `Retry` validates
  the widened ownership against the other workers and issues a new packet.
- **Integration conflict.** Split the ownership differently and start a new batch.
- **Parent drift at Apply.** Review the parent's new diff and start a new batch; the user's edit is
  never overwritten.
- **Repeated failure.** `Cancel`, `Cleanup`, and finish the remaining cases as ordered slices.

## After Apply

Return to [Finalization](evidence.md#finalization): the parent runs every acceptance case with
`evidence-run` (worker receipts never replace parent evidence), then one Reviewer reviews the
integrated diff, then `close-task`.
