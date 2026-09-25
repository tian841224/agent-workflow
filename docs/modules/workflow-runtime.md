---
doc_type: module
covers:
  - src/lifecycle/
  - src/misc.ts
  - src/workflow-policy.ts
  - src/project-doc.ts
  - src/task-context.ts
  - src/task-report.ts
  - src/orchestration/
  - scripts/run-tests.mjs
  - schemas/task.schema.json
  - schemas/orchestration.schema.json
  - schemas/workflow-policy.json
  - schemas/cli-output.schema.json
---

# Workflow runtime

## Responsibility

The runtime owns task classification, lifecycle transitions, compiled workflow plans, evidence freshness, project-document checks, and generated task reports. It does not decide whether an agent's initial risk classification is truthful; it enforces the declared plan and rejects stale or incomplete evidence.

## Entrypoints

The command registry is `commandOptions` in `src/cli.ts`; the managed lifecycle uses the commands in the workflow skill's command card.

## Flow

`task.md (Goal/Scope/Completion criteria + Given/When/Then acceptance cases) > task-init --paths (returns compiled plan, readiness, context, next) > selected procedures`

`focused: implementation > focused feedback > evidence-run acceptance cases and proofs > Reviewer (code tasks except mechanical) > close-task (evaluates gate)`

`expanded: ordered slice (goal/scope/acceptance/local verification/dependencies) > local feedback > next dependent slice > all slices complete > evidence-run acceptance cases and proofs > task-level Reviewer > close-task (evaluates gate)`

Focused file-local work stays direct. Expanded, cross-module, high-risk, or multi-behavior work uses
ordered slices unless `task-init` reports `parallel_hint.candidate` and `orchestrate --action Assess`
judges the split both safe and worthwhile. Eligible parallel work uses protocol 3 to snapshot the dirty parent, create detached worktrees, build child
`ExecutionPacket`s, collect immutable artifacts, integrate, and apply once. The task-level Reviewer
starts only after all workers and overall affected/regression validation are complete. The timing rule
is owned by [workflow review procedure](../../.agents/skills/workflow/review.md).

`task-init`、`task-write` 與 `execution-packet` 共用 procedure resolver；focused task 只取得 selected capability 的文件，expanded 或 coordinator／worker task 才加入對應的探索與角色文件。一次 `task-gate` evaluation 對同一個 repository snapshot 只建立一份 delivery snapshot，所有 execution evidence 共用它做 freshness 檢查。

`pre-review > reviewer > review-record`：`pre-review` 一次回傳 `git diff --check` 結果與該工作樹的 `workspace_sha256`；帶 `--task-path` 時另外回傳這一輪的 review brief（第一輪是完整 delivery，之後只有上一輪之後內容有變動的路徑，並附上一輪的結論、驗收案例與 checklist）。`review-record` 可接受這個 transient `--expected-workspace-sha256`；若工作樹已變更就拒絕寫入，review 欄位與每個路徑的 digest 仍由 runtime 依目前 diff 計算。

每個 task 指令的輸出都附上 `next`：由 gate 的缺口（intent、分類、驗收案例、proofs、Reviewer）推出補上缺口的完整指令，全部滿足時指向 `close-task`。

`project-doc Lookup/Check/Remember > document metadata and section validation > project_docs task state`

`task.json + task.md > task-report > disposable Markdown view`

Runtime execution evidence is recorded only after the command exits. It keeps the command, cwd,
exit code, output digest, and delivery freshness; `evidence.at` is the record timestamp, not an
execution-time measurement. The pre-spawn snapshot and the in-lock post-command snapshot must agree
on plan hash, intent hash, and delivery fingerprint. Code tasks fingerprint every path from
`base_commit`; managed non-code tasks fingerprint the current repository worktree.

## Shared state

`task.json` is the machine authority for lifecycle, classification, project document bookkeeping, evidence, plan revisions, waivers, and approvals. The sibling `task.md` is the human intent authority for Goal, Scope, and Completion criteria. `schemas/workflow-policy.json` selects capabilities and steps; `schemas/task.schema.json` validates persisted state.

## Invariants and gotchas

- Every acceptance case of a code-change managed task needs its own runtime receipt; the receipt binds `intent_hash` and the delivery fingerprint, not the plan, so reclassification leaves it valid.
- Only `runtime_execution` steps (the plan's `proofs`) and roles are gate items; analysis steps are the plan's `checklist`, an undecided `workflow_facts` condition keeps an analysis step on it, while an undecided runtime step stays a proof marked `undecided_by` until the fact is declared.
- Runtime evidence without a delivery fingerprint is stale and cannot satisfy a gate.
- A non-zero command is recorded as a failed observation, not a passing receipt.
- `task-report` never writes task state and never changes gate results.
- Explicit test paths are validated; a missing path fails instead of silently running zero tests. `scripts/run-tests.mjs` makes the validation scope explicit: focused and affected require selected paths, regression accepts a selected subsystem or all tests, and full runs the complete suite.
- `project-doc Remember` records only documents that were actually checked and read; Lookup reports `reusable` only when both the path and current `content_sha256` are present in task state.
- `review-record` never accepts persisted review scope or digest fields from the caller; `--expected-workspace-sha256` is only a pre-review freshness guard and is not stored as role evidence.
- Role evidence is fail-closed on scope: a changed path that `reviewed_paths` does not cover invalidates the review, so a delivery that grows after a PASS needs another review round.

## Unverified

Remote CI and installed platform copies require release verification after the source bundle is rebuilt.
