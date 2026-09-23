# Evidence procedure

Read this when the procedures returned by task-init (or an ExecutionPacket) include it. The selected
capabilities and step titles are already decided; use them as the work list and record only the
conclusions that belong to those steps. Command syntax is in the workflow skill's command card.

## Shared analysis

Build one concise evidence map for the task: entrypoints, affected callers, shared state, important
error or concurrency branches, validation commands, and known gaps. Let multiple selected steps point
to the same map, adding only the conclusion unique to that step. Do not repeat the same repository
search or rewrite the same finding for each step.

## Recording

The work list is the plan's `required_evidence` (the ids the gate checks). Use one `evidence-record`
or `evidence-run` command with repeated or comma-separated `--requirement-id` values when one
conclusion or command satisfies multiple selected evidence steps. The runtime writes one evidence
entry per id and one state revision for the batch. Every id must be a selected evidence step; role
results use `review-record`.

Write the attested steps of a capability (or of the whole task) in one `evidence-record` batch from
the shared map, with a summary that names the concrete finding. One call per step repeats the same
round trip and state write for no extra evidence.

## Classification before evidence

Before the first formal evidence batch, reuse the compiled plan and resolve every known
`classification_incomplete` and `step_classification_incomplete` entry. Declare the missing task
classification or `workflow_facts` in one `task-write`, then record evidence against the
resulting plan. New risk discovered during exploration still triggers the normal reclassification and
freshness rules; this ordering only prevents known omissions from invalidating an earlier evidence
batch.
## Setup and handoff

`task-init` returns `readiness` with fixed environment failures grouped before exploration,
implementation, or validation starts; `preflight` repeats the same checks only for manual diagnosis.
A handoff names the current task state, worktree diff, changed paths, and blockers; one coordinator
owns writes to a worktree at a time, and the incoming coordinator checks those items before continuing.

Runtime execution evidence must come from `evidence-run`. Its freshness is currently delivery-wide:
reuse a result only while the task plan, intent, command scope, complete delivery fingerprint, and
relevant environment remain the same. A change anywhere in the delivered worktree invalidates the
receipt; do not infer path-scoped reuse without a separately verified dependency map. Ticking a
Completion criteria checkbox does not change the intent hash. The final sequence is in
[Finalization](#finalization).

## Implementation slices and local feedback

`focused` file-local work follows `implementation -> focused feedback` directly. `expanded` work that needs
ordered slices follows [elevated.md](elevated.md#ordered-implementation-slices). Each slice gets local
feedback only, with one Reviewer for the whole task; once the delivery is stable, continue with
[Finalization](#finalization).

## Finalization

Runs once, after source, tests, and documents are stable:

1. `evidence-run` the affected/regression checks, batching every requirement id that command covers,
   including `delivery_validation.DV1` when it covers delivery validation. A separate DV1 command is
   needed only when the existing command does not cover it.
2. When the plan selects a Reviewer, run it once per the timing in [review.md](review.md). Read-only
   review leaves the receipt reusable; findings that change the delivery require fresh validation,
   rerunning each distinct final command once.
3. `close-task`, which evaluates the gate itself. Use `task-gate` only to diagnose a failed
   `close-task`, never before it.

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
