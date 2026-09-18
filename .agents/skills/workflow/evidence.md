# Evidence procedure

Read this when an ExecutionPacket contains evidence capabilities. The packet's selected capability
and step titles are already decided; use them as the work list and record only the conclusions that
belong to those steps.

## Shared analysis

Build one concise evidence map for the task: entrypoints, affected callers, shared state, important
error or concurrency branches, validation commands, and known gaps. Let multiple selected steps point
to the same map, adding only the conclusion unique to that step. Do not repeat the same repository
search or rewrite the same finding for each step.

## Recording

Use one `evidence-record` or `evidence-run` command with repeated or comma-separated
`--requirement-id` values when one conclusion or command satisfies multiple selected evidence steps.
The runtime writes one evidence entry per id and one state revision for the batch. Every id must be a
selected evidence step; role results use `review-record`.

## Classification before evidence

Before the first formal evidence batch, reuse the compiled plan and resolve every known
`classification_incomplete` and `step_classification_incomplete` entry. Declare the missing task
classification or `workflow_facts` in one classification update, then record evidence against the
resulting plan. New risk discovered during exploration still triggers the normal reclassification and
freshness rules; this ordering only prevents known omissions from invalidating an earlier evidence
batch.
## Setup and handoff

`task-init` returns `readiness` with fixed environment failures grouped before exploration,
implementation, or validation starts; `preflight` repeats the same checks only for manual diagnosis.
During implementation, keep one shared map of entrypoints, callers, boundaries, validation commands, and
unknowns; pass that map by reference and add only new conclusions to each evidence step. A handoff
names the current task state, worktree diff, changed paths, and blockers; one coordinator owns writes
to a worktree at a time, and the incoming coordinator checks those items before continuing.

Runtime execution evidence must come from `evidence-run`. Its freshness is currently delivery-wide:
reuse a result only while the task plan, intent, command scope, complete delivery fingerprint, and
relevant environment remain the same. A change anywhere in the delivered worktree invalidates the
receipt. Use the implementation flow below for local feedback, then run the final regression and
delivery receipt once after source, tests, and documents are stable, then follow the review flow below. If anything in the
delivery changes afterward, rerun each distinct required final command once, batching the requirement
ids it actually covers; do not infer path-scoped reuse without
a separately verified dependency map.

## Implementation slices and local feedback

The coordinator chooses the smallest flow that matches the task:

- `focused` file-local work follows `implementation -> focused feedback` directly.
- `expanded` work that crosses modules, carries higher risk, or contains multiple independent
  behaviors uses ordered implementation slices. Each slice states its goal, scope, acceptance
  criteria, local verification command, and dependencies. A dependent slice waits until the previous
  slice's local feedback passes.

Slices are coordinator working notes. They do not add slice state to `task.json`, change the
`ExecutionPacket` or evidence authority, or add a feedback CLI. Eligible independent ownership
scopes may use protocol 3 from [orchestration.md](orchestration.md), but that batch still keeps the
parent task, evidence, Reviewer, and close authority with the coordinator. Do not add a human approval or a second Reviewer to every slice. Each
slice receives local feedback only. After every slice is complete and the delivery is stable, run the
affected/regression checks through `evidence-run`, including `delivery_validation.DV1` in the same
batch when that command covers delivery validation. Then follow the task-level review timing in [review.md](review.md) for one Reviewer and close with `close-task`, which evaluates the gate itself. Read-only review leaves a matching receipt reusable; review findings that change the delivery require fresh
validation. A separate DV1 command is needed only when the existing command does not cover delivery
validation. Use `task-gate` only to diagnose a failed `close-task`, never as a step before it.

## Scope

Keep analysis proportional to the selected steps and the task impact. A direct, well-reproduced fix
does not need a speculative diagnosis sequence; an unresolved or repeatedly failing fix does. Whether
a parallel split is worthwhile is decided in [orchestration.md](orchestration.md#worthwhile-before-eligible).

## Validation command

`focused|affected|regression|full` is a scope (which impact-map paths the run must cover), not a
command. `focused`/`affected` need explicit paths; `regression` may target a subsystem or the full set;
`full` runs the whole suite. Run the target project's own native test command at that scope (`go test
./path/...`, `npm test -- path`, ...) — `scripts/run-tests.mjs` only runs this framework's own
`tests-node/` suite, not a general contract. The scope belongs to the command, not to a task field.

Every managed delivery needs a `delivery_validation.DV1` runtime receipt, whatever else the packet selected.
