---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow；進入後只讀 compiled plan 與被指向的 procedure。純文件、唯讀分析與不降低驗證能力的 test-only 修改 bypass；可能影響執行、資料、契約、安全性、部署、交付或 test integrity 的修改進入 workflow。
---

# agent-workflow

本檔只負責分流與指向 procedure。欄位與選取規則以 `schemas/task.schema.json`、`schemas/workflow-policy.json` 與 runtime compiled plan 為準。

1. `managed_change: false` 直接處理。`true` 時先寫 task.md 的 Goal、Scope、Completion criteria，再以 `agent-workflow task-init --task-path <path>` 一次傳入已知分類與 `workflow_request`；freeze-required intent 另列 Non-goals／Acceptance cases。
2. 建立後執行一次 `agent-workflow preflight --task-path <path> --repo-root <repo-root>`，處理 blocker，再讀 compiled plan 指向的 procedures。重用回傳的 plan；分類補充與變更見 [capability-selection.md](capability-selection.md)。
3. 修改 application source code 前依 [project-docs](../project-docs/SKILL.md) Lookup → 讀取 → Remember；修改其 logic 時套用 [clean-comments](../clean-comments/SKILL.md)。
4. 依 plan 實作、驗證、記錄 evidence，完成選取的角色；驗證與 freshness 見 [evidence.md](evidence.md)，reviewer 見 [review.md](review.md)。安裝、同步、部署、migration、provisioning 或外部整合時另讀 [operational-verification](../operational-verification/SKILL.md)。
5. 完成後直接 `agent-workflow close-task --task-path <path>`；只在診斷 blocker 時先用 `task-gate`。`task.json` 一律透過 runtime CLI 寫入。

## 分支入口

- expanded exploration：[elevated.md](elevated.md)
- 分類、reclassify 與 legacy compatibility：[capability-selection.md](capability-selection.md)、[risk-flags.md](risk-flags.md)
- coordinator／Worker 與 ExecutionPacket：[orchestration.md](orchestration.md)
- 記憶與學習：[memory.md](memory.md)；使用者要求記憶、糾正、拍板決策或確認錯誤修正時依 [learn](../learn/SKILL.md) 處理
