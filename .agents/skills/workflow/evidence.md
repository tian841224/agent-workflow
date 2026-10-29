# Evidence procedure

Read this when the procedures returned by task-init include it. The gate items are already decided:
every acceptance case in task.md, the plan's `proofs`, and the selected roles. Each command's `next`
lists the ones still missing, with the exact command. Command syntax is in the workflow skill's
command card.

## Shared analysis

Build one concise evidence map for the task: entrypoints, affected callers, shared state, external
contracts, important error, retry or concurrency branches, validation commands, and known gaps. Cover the plan's `checklist` items
in that map, adding only the conclusion unique to each item. The map is working context for the
implementation and the reviewer brief; it is not recorded as evidence.

## Recording

Only runtime-executed runs count. `evidence-run` executes the command itself and records its exit code,
output digest and the delivery fingerprint. A run that exits non-zero is recorded as a
failure; fix the delivery and run again until it passes.

## Setup and handoff

Reuse the environment checks that passed in `task-init`'s `readiness`; recheck when the environment
changes or a new error calls the result into question. A handoff names the current task state, worktree diff, changed
paths, and blockers; one coordinator owns writes to a worktree at a time, and the incoming coordinator
checks those items before continuing.

Runtime evidence freshness is delivery-wide: a change anywhere in the delivered worktree invalidates
every earlier run, and a changed Goal/Scope/Completion criteria invalidates it as well. Ticking a
Completion criteria checkbox does not change the intent hash. The final sequence is in
[Finalization](#finalization).

## Implementation slices and local feedback

`focused` file-local work follows `implementation -> focused feedback` directly. `expanded` work that needs
ordered slices follows [elevated.md](elevated.md#ordered-implementation-slices). Each slice gets local
feedback only, with one Reviewer for the whole task; once the delivery is stable, continue with
[Finalization](#finalization).

## Finalization

Runs once, after source and tests are stable:

1. Check each project doc covering the delivered paths per section 2 of
   [project-docs](../project-docs/SKILL.md): update the ones whose recorded facts no longer hold and
   record the rest in `project_docs.unchanged`. A delivered path no doc covers gets a doc covering it, or a
   `project_docs.not_warranted` entry with its reason. A doc edit changes the delivery, so this comes before any run.
2. `evidence-run` every acceptance case and proof, batching the ids each distinct command covers.
3. When the plan selects a Reviewer, run it per [review.md](review.md). Read-only review leaves the runs
   reusable; findings that change the delivery require running each distinct final command once more.
4. `close-task`, which evaluates the gate itself and returns `next` when something is still missing.

## Scope

Keep analysis proportional to the checklist and the task impact. A direct, well-reproduced fix does not
need a speculative diagnosis sequence; an unresolved or repeatedly failing fix does. Subagent
decisions follow the entrypoint's `Subagent` section; worker feedback does not replace the parent's final evidence.

## Validation command

`focused|affected|regression|full` is a scope (which impact-map paths the run must cover), not a
command. `focused`/`affected` need explicit paths; `regression` may target a subsystem or the full set;
`full` runs the whole suite. Run the target project's own native test command at that scope (`go test
./path/...`, `npm test -- path`, ...) — `scripts/run-tests.mjs` only runs this framework's own
`tests-node/` suite, not a general contract. Acceptance cases use the command written in their Verify
clause; UI cases use the project's e2e runner.
