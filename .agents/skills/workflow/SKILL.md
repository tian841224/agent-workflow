---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow；進入後依 compiled plan 執行影響行為、資料、契約、安全性、交付或 verification integrity 的變更。
---

# agent-workflow

本檔只負責分流與指向 procedure。欄位與選取規則以 `schemas/task.schema.json`、`schemas/workflow-policy.json` 與 runtime compiled plan 為準。

1. `managed_change: false` 直接處理。`true` 時先寫好 task.md：標題層級固定是 `## Goal`／`## Scope`／`## Completion criteria`（二級標題，不是 `#`），完整樣板見 canonical 共用目錄的 `~/.agents/templates/task.md`（非本資料夾內）；freeze-required intent 另列 Non-goals／Acceptance cases，runtime 會直接記錄 agent attestation（見 [risk-flags.md](risk-flags.md#意圖確認)）。再以下方指令卡的 `task-init` 一次傳入已知分類與 `workflow_facts`。
2. `task-init` 一次回傳 task、compiled plan、procedures 與 `readiness`。`readiness.ready` 為 false 時先處理 blockers，再讀 plan 指向的 procedures。重用回傳的 plan；分類補充與變更見 [capability-selection.md](capability-selection.md)。
3. 一般 logic change 在實作期間只遵守 `AGENTS.md` 的短註解規則；只有新增／重寫多行註解、public/doc comments、高風險判斷依據，或 review 發現 comment pollution 時才主動讀 [clean-comments](../clean-comments/SKILL.md) 查邊界案例。交付 review 一併檢查本次新增或修改的註解。只有 procedures 含 [project-docs](../project-docs/SKILL.md) 時才做 Lookup → 讀取；Remember 只在讀取結果需要跨階段、Reviewer 或重啟後重用時才寫。
4. 依 plan 實作、驗證、記錄 evidence，完成選取的角色；驗證與 freshness 見 [evidence.md](evidence.md)，reviewer 見 [review.md](review.md)。安裝、同步、部署、migration、provisioning 或外部整合時另讀 [operational-verification](../operational-verification/SKILL.md)。
5. 完成後直接 `close-task`；它自己執行 gate。只有 close-task 失敗、需要診斷 blocker 時才用 `task-gate`。`task.json` 一律透過 runtime CLI 寫入。

## 指令卡

`<task>` 是 task 目錄（也可給其中的 task.md）。照抄即可，不需要先查 `--help`；參數錯誤時錯誤訊息會列出合法參數。

- 建立：`echo '<分類 JSON，含已知 workflow_facts>' | agent-workflow task-init --task-path <task> --repo-root <repo>`
- 補 `step_classification_incomplete` 的 facts、加 flag 或調高 confidence：`echo '{"workflow_facts":{...}}' | agent-workflow task-write --task-path <task>`。移除 flag 或降級才用 `reclassify --confirmed-by-user <文字> --reason <文字>`。
- attested 步驟，一次批次：`agent-workflow evidence-record --task-path <task> --requirement-id a.X1,b.Y2 --summary <具體結論>`
- runtime 步驟（DV1 與標題註明 evidence-run 的步驟）：`agent-workflow evidence-run --task-path <task> --requirement-id <ids> --summary <結論> --cwd <dir> -- <command>`
  - 「改壞後測試變紅」這類步驟用一支放在 repo 外的腳本，在同一個 command 內完成改壞 → 跑測試 → 以檔案複本還原，測試失敗時回傳 0。還原不用 git，交付檔也要回到原樣。
- Reviewer：在 repo root 跑 `agent-workflow pre-review`，把回傳的 `workspace_sha256` 交給 `agent-workflow review-record --task-path <task> --role reviewer --result pass --summary <text> --expected-workspace-sha256 <sha>`。
- 結案：`agent-workflow close-task --task-path <task>`；生命週期：`agent-workflow supersede --task <task>`（pause／block／resume 同形）。

## 分支入口

- expanded exploration 與 ordered slices：[elevated.md](elevated.md)
- 分類、reclassify 與 legacy compatibility：[capability-selection.md](capability-selection.md)、[risk-flags.md](risk-flags.md)
- coordinator／Worker 與 ExecutionPacket：[orchestration.md](orchestration.md)
- 記憶與學習：[memory.md](memory.md)；使用者要求記憶、糾正、拍板決策或確認錯誤修正時依 [learn](../learn/SKILL.md) 處理
