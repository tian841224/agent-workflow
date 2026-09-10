---
doc_type: module
covers:
  - src/lifecycle/
  - src/misc.ts
  - src/workflow-policy.ts
  - src/project-doc.ts
  - src/task-report.ts
  - scripts/run-tests.mjs
  - schemas/task.schema.json
  - schemas/workflow-policy.json
  - schemas/cli-output.schema.json
---

# Workflow runtime

## Responsibility

The runtime owns task classification, lifecycle transitions, compiled workflow plans, evidence freshness, project-document checks, and generated task reports. It does not decide whether an agent's initial risk classification is truthful; it enforces the declared plan and rejects stale or incomplete evidence.

## Entrypoints

The Node CLI dispatches `task-init`, `task-write`, `workflow-plan`, `evidence-run`, `evidence-record`, `review-record`, `task-gate`, `close-task`, `project-doc`, `task-report`, and `pre-review`.

## Flow

`task-init/task-write > compiled plan > implementation > evidence-run > delivery fingerprint check > task-gate > close-task`

`task-init`、`task-write` 與 `execution-packet` 共用 procedure resolver；focused task 只取得 selected capability 的文件，expanded 或 coordinator／worker task 才加入對應的探索與角色文件。一次 `task-gate` evaluation 對同一個 repository snapshot 只建立一份 delivery snapshot，所有 execution evidence 共用它做 freshness 檢查。

`pre-review > reviewer > review-record`：`pre-review` 一次回傳 `git diff --check` 結果與該工作樹的 `workspace_sha256`，`review-record` 可接受這個 transient `--expected-workspace-sha256`；若工作樹已變更就拒絕寫入，review 欄位仍由 runtime 依目前 diff 計算。

`project-doc Lookup/Check/Remember > document metadata and section validation > project_docs task state`

`task.json + task.md > task-report > disposable Markdown view`

Runtime execution evidence is recorded only after the command exits. The pre-spawn snapshot and the in-lock post-command snapshot must agree on plan hash, intent hash, and delivery fingerprint. Code tasks fingerprint every path from `base_commit`; managed non-code tasks fingerprint the current repository worktree.

## Shared state

`task.json` is the machine authority for lifecycle, classification, validation profile, project document bookkeeping, evidence, plan revisions, waivers, and approvals. The sibling `task.md` is the human intent authority for Goal, Scope, and Completion criteria. `schemas/workflow-policy.json` selects capabilities and steps; `schemas/task.schema.json` validates persisted state.

## Invariants and gotchas

- `delivery_validation.DV1` is the minimum runtime receipt for every managed delivery; it does not replace high-risk evidence.
- Runtime evidence without a delivery fingerprint is stale and cannot satisfy a gate.
- A non-zero command is recorded as a failed observation, not a passing receipt.
- `task-report` never writes task state and never changes gate results.
- Explicit test paths are validated; a missing path fails instead of silently running zero tests. `scripts/run-tests.mjs` makes the validation profile explicit: focused and affected require selected paths, regression accepts a selected subsystem or all tests, and full runs the complete suite.
- `project-doc Remember` records only documents that were actually checked and read; Lookup reports `reusable` only when both the path and current `content_sha256` are present in task state.
- `review-record` never accepts persisted review scope or digest fields from the caller; `--expected-workspace-sha256` is only a pre-review freshness guard and is not stored as role evidence.
- Role evidence is fail-closed on scope: a changed path that `reviewed_paths` does not cover invalidates the review, so a delivery that grows after a PASS needs another review round.

## Unverified

Remote CI and installed platform copies require release verification after the source bundle is rebuilt.
