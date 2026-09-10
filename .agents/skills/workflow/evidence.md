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

## Timing and handoff

Run `agent-workflow preflight --task-path <path> --repo-root <repo-root>` once after task creation. It
groups fixed environment failures before exploration, implementation, or validation starts. During
implementation, keep one shared map of entrypoints, callers, boundaries, validation commands, and
unknowns; pass that map by reference and add only new conclusions to each evidence step.

Runtime execution evidence must come from `evidence-run`. Its freshness is currently delivery-wide:
reuse a result only while the task plan, intent, command scope, complete delivery fingerprint, and
relevant environment remain the same. A change anywhere in the delivered worktree invalidates the
receipt. Use focused checks for local feedback, then run the final regression and delivery receipt once
after source, tests, documents, and review are stable. If anything in the delivery changes afterward,
rerun every required final command; do not infer path-scoped reuse without a separately verified
dependency map.

## Scope

Keep analysis proportional to the selected steps and the task impact. A direct, well-reproduced fix
does not need a speculative diagnosis sequence; an unresolved or repeatedly failing fix does. A
parallel split is worthwhile only when its independent work is expected to save more time than context
handoff, worktree setup, integration, and final verification.

## Validation command

`focused|affected|regression|full` is a scope (which impact-map paths the run must cover), not a
command. `focused`/`affected` need explicit paths; `regression` may target a subsystem or the full set;
`full` runs the whole suite. Run the target project's own native test command at that scope (`go test
./path/...`, `npm test -- path`, ...) — `scripts/run-tests.mjs` only runs this framework's own
`tests-node/` suite, not a general contract. `validation_profile` is optional metadata.

Every managed delivery needs a `delivery_validation.DV1` runtime receipt, whatever else the packet selected.
