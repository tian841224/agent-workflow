---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow；進入後依 compiled plan 執行影響行為、資料、契約、安全性、交付或 verification integrity 的變更。
---

# agent-workflow

本檔只負責流程與指向 procedure。欄位與選取規則以 `schemas/task.schema.json`、`schemas/workflow-policy.json` 與 runtime compiled plan 為準。

1. `managed_change: false` 直接處理。
2. **開發前定義目標與驗收標準。** 需求不明確時，先依 [planning](../planning/SKILL.md) 與使用者釐清；高風險或分支未明時再用 [grill-me](../grill-me/SKILL.md) 多輪問答，直到目標與驗收標準明確並經使用者確認。需求明確時直接寫，並在開始實作的進度訊息列出驗收標準。
3. 寫 task.md，樣板是 `~/.agents/templates/task.md`。二級標題固定為 `## Goal`／`## Scope`／`## Completion criteria`。`code_change: true` 時，在 Completion criteria 下寫 `### Acceptance cases`，每條包含 Given／When／Then 與一行 Verify 指令（放在 code span 內）。UI 行為的驗證用 e2e。純機械性、不改變行為的修改（改名、搬移、格式、有測試保護的常數）用 `task_type: mechanical`。
4. 用 `task-init --paths <這次會碰到的路徑>` 建立 task。回傳內容：
   - plan、`readiness`、`next`
   - `context`：相關的專案文件、記憶，以及改過同一批路徑的已結案 task

   `readiness.ready` 為 false 時先處理 blockers。開發前先讀 context 列出的文件與記憶。有 `doc_gap` 時，依 [project-docs](../project-docs/SKILL.md) 為這次碰到的模組補一份文件。分類補充見 [capability-selection.md](capability-selection.md)。
5. 實作。plan 的 `checklist` 是實作與 review 都要涵蓋的分析項目；`proofs` 和驗收案例一樣，要用 `evidence-run` 實際執行。註解只遵守 `AGENTS.md` 的短規則；新增或重寫多行註解、public/doc comments、高風險判斷依據時，才讀 [clean-comments](../clean-comments/SKILL.md)。安裝、同步、部署、migration、provisioning 或外部整合時，另讀 [operational-verification](../operational-verification/SKILL.md)。
6. 之後照每個指令輸出的 `next` 走：它列出 gate 目前的缺口，以及補上缺口的完整指令，依序是 acceptance 與 proof 的 `evidence-run` → Reviewer（見 [review.md](review.md)）→ `close-task`。驗收失敗就修正後重跑，直到全部通過。驗證順序與 freshness 見 [evidence.md](evidence.md)。
7. bug 修好或 review 確認問題後，依 [root-cause](../root-cause/SKILL.md) 補上防止再發生的測試、文件、規範或 workflow 修正。使用者做的決策、更正與可重用結論，依 [learn](../learn/SKILL.md) 記錄。

## 指令卡

task 狀態一律經由下列指令寫入。`<task>` 是 task 目錄，也可以給其中的 task.md。參數錯誤時，錯誤訊息會列出合法參數。

- 建立：`echo '<分類 JSON>' | agent-workflow task-init --task-path <task> --repo-root <repo> --paths <path1,path2>`
- 補分類、加 flag 或調高 confidence：`echo '{...}' | agent-workflow task-write --task-path <task>`。移除 flag 或降級只能用 `reclassify --confirmed-by-user <文字> --reason <文字>`。
- 驗收案例與 proof，Verify 指令相同的可以合併成一次：`agent-workflow evidence-run --task-path <task> --requirement-id acceptance.AC1,acceptance.AC2 --summary <結論> --cwd <repo> -- <command>`
  - 「改壞後測試變紅」這類 proof：用一支放在 repo 外的腳本，在同一個 command 內完成改壞 → 跑測試 → 以檔案複本還原，測試失敗時回傳 0。還原不要用 git，交付檔也要回到原樣。
- Reviewer：`agent-workflow pre-review --path <repo> --task-path <task>` 回傳這一輪的 review 範圍與 `workspace_sha256`；review 完成後執行 `agent-workflow review-record --task-path <task> --role reviewer --result <pass|fail> --summary <text> --expected-workspace-sha256 <sha>`。
- 結案：`agent-workflow close-task --task-path <task>`。它會自己執行 gate；失敗時的輸出已附 `next`。
- 生命週期：`agent-workflow supersede --task <task>`，pause／block／resume 的寫法相同。

## 分支入口

- expanded exploration 與 ordered slices：[elevated.md](elevated.md)
- 分類、reclassify 與 freeze-required intent：[capability-selection.md](capability-selection.md)、[risk-flags.md](risk-flags.md)
- 記憶的讀取與寫入：[memory.md](memory.md)
- `task-init` 回傳 `parallel_hint.candidate: true` 時，判斷並執行多 worker 平行開發：[orchestration.md](orchestration.md)
