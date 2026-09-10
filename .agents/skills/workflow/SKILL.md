---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow；進入後只讀 compiled plan 與被指向的 procedure。純文件、唯讀分析與不降低驗證能力的 test-only 修改 bypass；可能影響執行、資料、契約、安全性、部署、交付或 test integrity 的修改進入 workflow。
---

# agent-workflow

這份文件是 router，不是 workflow 規則的第二份 authority。修改 framework 的 agents、skills、hooks 或 contract 前，先讀 [architecture.md](../../../docs/architecture.md)。`task.json` 只能透過 runtime CLI 寫入；schema、policy 與各 procedure 才是欄位和步驟的 authority。

## Router

```text
managed_change?
  ├─ false → 直接處理，不建立 task
  └─ true
       ↓
task-init（回傳 compiled plan + procedures）
       ↓
只讀 plan 指向的文件與 project docs
       ↓
implementation
       ↓
依 compiled plan 決定測試範圍並執行 run-tests
       ↓
evidence-run / evidence-record
       ↓
必要時 review-record
       ↓
close-task（自動重跑 completion gate）
```

1. 先判斷 `managed_change`。它是 workflow 的唯一 entry gate；`code_change` 只描述是否修改 application source code。設定、script、schema、測試可信度與交付行為依是否可能改變執行結果判斷，不以檔案副檔名 bypass。
2. `managed_change: true` 時建立 task intent，執行 `agent-workflow task-init --task-path <path>`，一次傳入已知分類與 `workflow_request`。回應已包含 `required`、`selected`、`order`、`exploration_profile` 與 procedure pointers；後續分類變更或 `project_docs.updated`／`independence` bookkeeping 才使用 `task-write`。分類變更會回傳新的 plan，非分類更新只回傳 task 與 `state_revision`。
3. 只依 compiled plan 載入 procedure。capability 名稱、step 條件與執行順序以 `schemas/workflow-policy.json` 和 `workflow-plan` 輸出為準；不要在入口文件複製清單。
4. 修改 application source code 前依 [project-docs skill](../project-docs/SKILL.md) 走 Lookup → 讀命中文件 → Remember，它擁有查詢、閱讀與回填的完整規則。
5. `focused`／`expanded` 由 runtime 從同一份分類推導，不另判 Standard／Elevated。compiled plan 回報 `expanded` 時讀 [elevated.md](elevated.md)；selected capability 的操作規則在 [capability-selection.md](capability-selection.md)、[evidence.md](evidence.md)、[review.md](review.md) 及各專屬 skill。
6. 依 compiled plan 決定驗證範圍，執行 `node scripts/run-tests.mjs --profile <focused|affected|regression|full> [-- <path> ...]`；runner 自己拒絕不合法的 profile／路徑組合。測試路徑由 impact map 決定，不必再推理 focused 與 affected 的抽象差異；`regression` 表示 subsystem 或完整回歸意圖，`full` 固定執行整個 suite。`validation_profile` 是選填 metadata，不需為了執行測試填寫。開發期間保留必要的快速回饋，昂貴的回歸與最終 delivery receipt 等交付內容穩定後批次執行。純分析使用 `evidence-record`。
7. 每個 `managed_change: true` 交付至少要有 `delivery_validation.DV1` runtime receipt；宣告 `runtime_execution` 的 step 只接受 `evidence-run`。記錄方式與 freshness 見 [evidence.md](evidence.md)。
8. `reviewer` 被 required 或 requested 時，用 `review-record` 記錄唯一角色結果，主對話代跑時誠實記錄 `independence: degraded`；執行方式見 [review.md](review.md)。
9. `task.md` 只保存 Goal、Scope、Completion criteria，以及 freeze-required task 的 Non-goals／Acceptance cases。evidence、validation、review、lifecycle、project docs 與 hashes 只在 `task.json`；需要人讀時用 `agent-workflow task-report`。
10. 完成條件、evidence 與 reviewer 都完成後直接執行 `agent-workflow close-task`。只有需要診斷 blocker 時才先執行 `task-gate`；不要直接編輯 lifecycle 或 task.json。

## Hard invariants

- `managed_change: false` 不啟動 capability 或角色；既有 task 若後來確認會改變 runtime，使用 `task-write` 將它升級。
- `workflow_mode` 是 legacy compatibility 欄位；新流程省略它，舊 task 仍照 schema 接受，不能再用它另行判斷 workflow。
- `workflow_request` 只能在 runtime required 下加選；移除既有 risk flag 或把 `managed_change` 降回 false 只能走 `reclassify`，並留下使用者確認與原因。
- `impact_confidence` 不在受保護之列，調低它只會讓 gate 要求更多，可直接用 `task-write` 更新；計畫版本由 runtime 維護。
- `task.json` 的 evidence、waiver、reviewer 與 hashes 一律由 runtime 現算；agent 不自行填入 machine-managed 欄位。
- `close-task` 是唯一終態寫入路徑；`closed` 或 `superseded` task 不再接受狀態 mutation。

## References

- 分類與 capability selection：[capability-selection.md](capability-selection.md)、[risk-flags.md](risk-flags.md)
- evidence、runtime receipt 與 freshness：[evidence.md](evidence.md)
- expanded exploration 深度：[elevated.md](elevated.md)
- reviewer、review scope 與 delta-first 複查：[review.md](review.md)
- coordinator／worker：[orchestration.md](orchestration.md)
- memory 與 project-doc bookkeeping：[memory.md](memory.md)、[project-docs skill](../project-docs/SKILL.md)
