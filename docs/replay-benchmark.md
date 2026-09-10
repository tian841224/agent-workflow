# Representative Replay Benchmark

`workflow-cost.test.mjs` is a procedure-bytes regression guard, not a total workflow cost benchmark —
it never measures what a real task actually spends. This is the reporting template for that: no new
instrumentation, no framework. Pick one representative real task, replay it against the current
runtime, and fill in these numbers by hand from the transcript and tool-call log.

<!-- contract-lint: field/quality names below are benchmark report columns, not contract vocabulary -->

## What to record

Cost — report *unavailable* rather than a guessed number when the agent runtime exposes no telemetry
for it; never substitute procedure bytes for token counts:

- wall-clock time (ms)
- agent tokens in
- agent tokens out
- tool calls
- CLI calls (agent-workflow invocations specifically)
- files read
- bytes loaded
- rework events (a step redone because of a wrong command, a blocked write, a re-read, a failed
  validation that had to be retried)

Quality — unchanged pass/fail; a faster run that drops any of these is not an improvement:

- build
- focused tests
- regression tests
- mutation tests (when the task's risk profile requires it)
- review
- delivery gate

## How to use it

1. Keep the same task requirement, repo baseline, and risk flags across runs — only the runtime
   version changes.
2. Run the task once per runtime version you want to compare (e.g. "pre-fix" vs "current main" vs
   "after a specific change").
3. Record the numbers above for each run in a table like this one:

| run | wall-clock (ms) | tokens in | tokens out | tool calls | CLI calls | files read | bytes loaded | rework events | quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | | | | | | | | | pass/fail per gate |
| current main | | | | | | | | | |

4. A change only counts as a real win if cost drops (or stays flat) **and** every quality gate still
   passes. A shorter SKILL.md with the same or worse replay numbers is not progress.
