# Parallel orchestration

Read this when the native agent has chosen parallel implementation. Each platform agent decides whether to use subagents with its available native tools. The framework supplies no candidacy, payoff recommendation or mandatory assessment step. Protocol 3 manages implementation work packages; the parent retains classification, acceptance, Reviewer and closure. Read-only helpers use the platform's native tools.

## Validating a chosen split

Run Assess only to validate a supplied split. It returns eligible and errors, without recommending an execution mode. Valid plans have disjoint file_ownership, planned_files inside ownership, shared_files outside worker scopes, and every parent acceptance case assigned exactly once to a worker or coordinator_acceptance. Each worker has an acceptance case or independently verifiable completion_criteria. Declared worker dependencies and shared persistent state are rejected. Legacy min_files_per_worker and parallel_reason are accepted metadata and do not select execution mode.

After the agent chooses to proceed, follow Prepare and native dispatch. Use the platform's available tools; when native dispatch is unavailable, finish in the parent. Worker count is the agent's choice within the supplied max_workers budget.

## How to split

1. **By behavior first.** Group acceptance cases that can be verified independently; each group is one
   worker. Then find the directory prefixes that group changes; those are its `file_ownership`.
2. **Contracts before dispatch.** Shared types and interfaces, route or DI registration, index
   exports, configuration and lockfiles are `shared_files`. The coordinator writes them
   before `Prepare`; the snapshot carries them into every worktree, and workers build against them
   read-only.
3. **No waiting between workers.** When one group needs another's output, remove the dependency by
   writing the contract first; when that is impossible, keep those groups in ordered slices.
4. **Cross-worker cases stay with the parent.** An end-to-end case spanning several groups goes in
   `coordinator_acceptance` and runs after `Apply`.
5. **Coordinator-owned paths.** Optional coordinator_risks declarations reserve {flag, paths, reason} for work exclusive to the coordinator, outside worker ownership. Complete that work before Prepare or after Apply. Shared contracts are completed before dispatch. Parent risk flags, required proofs and approvals remain intact; they do not choose whether to use subagents.

```json
{
  "parent_task_path": "<parent task.json>",
  "repo_root": "<repo>",
  "max_workers": 2,
  "coordinator_risks": [{"flag": "schema", "paths": ["schemas/orchestration.schema.json"], "reason": "Coordinator completes the schema contract before Prepare."}],
  "shared_files": ["src/types/order.ts", "src/routes.ts"],
  "coordinator_acceptance": ["AC5"],
  "workers": [
    {"id": "api", "goal": "...", "acceptance": ["AC1", "AC2"], "file_ownership": ["src/api/"], "planned_files": ["src/api/order.ts", "src/api/validate.ts", "src/api/order.test.ts"]},
    {"id": "ui", "goal": "...", "acceptance": ["AC3", "AC4"], "file_ownership": ["src/ui/order/", "e2e/order.spec.ts"], "planned_files": ["src/ui/order/form.tsx", "src/ui/order/list.tsx", "e2e/order.spec.ts"]}
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

While workers run, the coordinator can inspect results or prepare notes outside the parent delivery. Keep the parent delivery unchanged from Prepare until Apply: Apply refuses parent drift. Coordinator-owned risk operations run before Prepare or after Apply, not during the batch.

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
  the widened ownership against the other workers, shared contracts and exclusive coordinator risk paths, and issues a new packet.
- **Integration conflict.** Split the ownership differently and start a new batch.
- **Parent drift at Apply.** Review the parent's new diff and start a new batch; the user's edit is
  never overwritten.
- **Repeated failure.** `Cancel`, `Cleanup`, and finish the remaining cases as ordered slices.

## After Apply

Return to [Finalization](evidence.md#finalization): the parent runs every acceptance case with
`evidence-run` (worker receipts never replace parent evidence), then one Reviewer reviews the
integrated diff, then `close-task`.
