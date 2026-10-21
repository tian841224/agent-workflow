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

Managed development follows the Plan mode and user specification approval procedure in [workflow](../../.agents/skills/workflow/SKILL.md), using [implementation-spec](../../.agents/skills/implementation-spec/SKILL.md) before entering the runtime; other managed tasks keep the goal/scope/completion-criteria path. Native mode switching and user approval are agent procedures, not guarantees enforced by the runtime gate.

`Plan mode (managed development) > implementation-spec > user specification approval > task.md (Goal/Scope/Completion criteria + Given/When/Then acceptance cases) > task-init --paths --confirmed-by <source> --as-user (records the approval; returns compiled plan, readiness, context, next) > selected procedures`

`focused: implementation > focused feedback > evidence-run acceptance cases and proofs > Reviewer (code tasks except mechanical) > close-task (evaluates gate)`

`expanded: ordered slice (goal/scope/acceptance/local verification/dependencies) > local feedback > next dependent slice > all slices complete > evidence-run acceptance cases and proofs > task-level Reviewer > close-task (evaluates gate)`

Native parallel decisions follow [workflow](../../.agents/skills/workflow/SKILL.md). The coordinator
uses available platform subagent tools and assigns goals, file scopes and acceptance directly.
Isolation and worker count are task-specific; the normal workflow requires no orchestration CLI or
packet. After integration, the parent executes all acceptance cases and proofs before the task-level
Reviewer. Review timing is owned by [workflow review procedure](../../.agents/skills/workflow/review.md).

The Protocol 3 runtime and packet interface are opt-in. Their snapshots, detached worktrees,
receipts and integration actions apply only when explicitly using that interface.

### Codex coordinator gate

已識別的 Codex coordinator 使用既有 task-init、task-write、readiness 與 close-task，不新增 scheduler 或事件 bridge。[Codex 指示](../../adapters/codex/coordinator.md) 擁有拆分與原生觀察程序，[task schema](../../schemas/task.schema.json) 擁有欄位形狀。task-init 的 execution_platform 明確值優先；未指定且 CODEX_THREAD_ID 存在時預設 Codex。一旦保存 Codex marker，task-write／reclassify 不可清除或改平台；gate 讀 persisted marker，legacy 與其他平台不受當前環境影響。

缺 assessment 可先建立 task，readiness 回報未就緒；執行紀錄只在完成 gate 要求。評估列出依賴、角色、scope、讀／寫 ownership 與驗收；至少兩個依賴上獨立的子任務且宣告收益足夠時必須 parallel，循序需具體原因。讀取可重疊，寫入以檔案／目錄及 Windows 大小寫規則檢查互斥，共用檔案由同一 owner 維持各階段工作。

Native ID 對應 subtask、role 與 scope。Parallel 需一筆 list_agents snapshot 同時觀察至少兩個不同子任務的 running ID；兩筆單獨 running、同一子任務多個 attempts 或序列 spawn 皆不算。當次所有 attempts 需有最新終態，各子任務至少一個 completed；失敗可換新 ID 重試，同一 ID 可登錄原生 follow-up 的後續觀察。前置子任務觀察到完成後才啟動相依工作。

原生紀錄由 task-write append-only 寫入既有 task.json 鎖；assessment 改動遞增 runtime-owned revision，receipt 綁定 assessment hash／revision 與 intent hash。改回原評估不復活舊紀錄，舊 ID 不可重新登錄取得 freshness。呼叫端不得填 hash、revision 或 recorded_at。缺少／無效 task.md 的 reader 與 writer 使用一致 sentinel，原本 intent gate 仍會失敗。

Codex worker 以既有 subtask_role=worker 與 parent_task_id 配對識別受派任務，schema 拒絕缺父任務的 worker；其 coordinator 委派 gate 豁免，不要求子代理再次拆分。父子宣告仍由 coordinator 持有，沒有平台事件可供 runtime 認證。大型唯讀工作使用 code_change／managed_change 都為 false 的輕量 Codex task；共用 managed entry gate 不變。沒有 task record 的小型唯讀委派只有 coordinator 核對，不能宣稱由 CLI 強制。

ID、角色／scope、觀察時間與 evidence 是 caller attestation。CLI 檢查結構、時間順序、參照、freshness 與同次 running snapshot，不驗證平台事件或解析私有 log；任務大小、實質獨立性、收益與理由的充分性仍由 coordinator 比對實際原生輸出。直接改 task.json、假造環境或初始化時宣告為其他平台仍在既有 agent trust boundary 內。這些觀察不代替 acceptance、runtime execution evidence 或獨立 review；focused tests 使用 synthetic receipts，實際載入與並行執行需在目標 Codex 環境核對。

`task-init`、`task-write` 與 `execution-packet` 共用 procedure resolver；在本 repo checkout 執行時回傳 `.agents/skills/...` 相對路徑，已安裝的 runtime 回傳 home 目錄下 `.agents/skills/...` 的絕對路徑，讓其他專案也解析得到；只有已宣告 coordinator role 的 task 加入相容的 coordinator 指引。focused task 另取得 selected capability 的文件，expanded 或 coordinator／worker task 才加入對應的探索與角色文件。一次 `task-gate` evaluation 對同一個 repository snapshot 只建立一份 delivery snapshot，所有 execution evidence 共用它做 freshness 檢查。

`pre-review > reviewer > review-record`：`pre-review` 一次回傳 `git diff --check` 結果與該工作樹的 `workspace_sha256`；帶 `--task-path` 時另外回傳這一輪的 review brief（第一輪是完整 delivery，之後只有上一輪之後內容有變動的路徑，並附上一輪的結論、驗收案例與 checklist）。`review-record` 可接受這個 transient `--expected-workspace-sha256`；若工作樹已變更就拒絕寫入，review 欄位與每個路徑的 digest 仍由 runtime 依目前 diff 計算。

每個 task 指令的輸出都附上 `next`：由 gate 的缺口（intent、分類、專案文件、驗收案例、proofs、Reviewer）推出補上缺口的完整指令，全部滿足時指向 `close-task`。專案文件排在所有 run 之前，因為修改文件會改變 delivery 並使 receipt 失效。

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

- A code task's minimal runtime proof is its acceptance cases; `baseline_validation.BV2` is a gate proof only for a managed task without code, which has no acceptance cases of its own.
- Capabilities backed by a skill (`tdd`, `bug_diagnosis`, `codebase_design`) list no steps in the policy; selecting one adds its skill to `procedures`.
- Every acceptance case of a code-change managed task needs its own runtime receipt; the receipt binds `intent_hash` and the delivery fingerprint, not the plan, so reclassification leaves it valid.
- Only `runtime_execution` steps (the plan's `proofs`) and roles are gate items; analysis steps are the plan's `checklist`, an undecided `workflow_facts` condition keeps an analysis step on it, while an undecided runtime step stays a proof marked `undecided_by` until the fact is declared.
- Runtime evidence without a delivery fingerprint is stale and cannot satisfy a gate.
- A non-zero command is recorded as a failed observation, not a passing receipt.
- `task-report` never writes task state and never changes gate results.
- Explicit test paths are validated; a missing path fails instead of silently running zero tests. `scripts/run-tests.mjs` makes the validation scope explicit: focused and affected require selected paths, regression accepts a selected subsystem or all tests, and full runs the complete suite. It clears inherited CODEX_THREAD_ID; Codex fixtures explicitly supply their marker so unrelated legacy fixtures keep their original platform.
- `project-doc Remember` records only documents that were actually checked and read; Lookup reports `reusable` only when both the path and current `content_sha256` are present in task state.
- A code task's gate requires every non-overview doc that Lookup routes the delivered paths to be edited in the delivery or named in `project_docs.updated`/`unchanged`. `unchanged` merges across `task-write` calls and is not bound to the delivery fingerprint, so the Reviewer's doc check is what catches a doc that drifted after it was recorded.
- A code task's gate also requires every delivered path outside `docs/` that no doc covers to gain a covering doc in the delivery or be named in `project_docs.not_warranted` with a reason; `next` asks for this before any run. `not_warranted` merges across `task-write` calls by path.
- `review-record` never accepts persisted review scope or digest fields from the caller; `--expected-workspace-sha256` is only a pre-review freshness guard and is not stored as role evidence.
- Role evidence is fail-closed on scope: a changed path that `reviewed_paths` does not cover invalidates the review, so a delivery that grows after a PASS needs another review round.

## Unverified

Remote CI and installed platform copies require release verification after the source bundle is rebuilt.
