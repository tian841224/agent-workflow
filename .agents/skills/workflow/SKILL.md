---
name: workflow
description: "需要判斷是否進入 managed workflow，或執行已編譯計畫要求的流程時使用；適用於影響行為、資料、契約、安全性、交付或驗證完整性的變更。"
---

# agent-workflow

本檔只負責流程與指向 procedure。欄位與選取規則以 `schemas/task.schema.json`、`schemas/workflow-policy.json` 與 runtime compiled plan 為準。

1. `managed_change: false` 直接處理。
2. **Managed 開發任務先載入 [implementation-spec](../implementation-spec/SKILL.md)，再進入平台原生 Plan mode。**
   - 需求不明確時，先依 [planning](../planning/SKILL.md) 與使用者釐清；高風險或分支未明時再用 [grill-me](../grill-me/SKILL.md)，直到目標與驗收標準明確。需求明確時直接撰寫規格。
   - Plan 階段只做唯讀探索與平台允許的規格撰寫，不修改交付程式、測試、設定，也不執行部署或資料變更。
   - 平台無法由 agent 切換模式或沒有原生 Plan mode 時，明確告知限制，仍先交付規格並等待使用者確認，不宣稱已切換模式。
   - 單一檔案、局部行為、影響明確且不帶 [risk-flags.md](risk-flags.md) 任何 flag 的修改，可以不切換 Plan mode，直接在對話提出 Goal、Scope 與驗收案例請使用者確認；確認的要求與第 3 步相同。
3. **依 implementation-spec 產出規格，交由使用者確認後才開始開發。**
   - 查閱相關程式、文件與測試後，依該 skill 的確認階段寫出 task.md：做什麼、動哪裡、怎麼驗；實作設計留到核准後展開。
   - Plan mode 限制寫入時，先用平台允許的計畫檔或對話交付這份規格，確認後再將同一份內容保存為 task.md；有計畫檔時用檔案複製，不重新輸出內容。
   - 確認須對應這份規格；最初的開發請求、只確認需求方向或沒有回覆，都不算規格核准。取得明確確認後才退出 Plan mode、執行 task-init 與實作；規格有影響行為、範圍、契約或驗收的變更時，先重新取得確認。
   - 其餘 managed 任務維持目標、範圍與完成條件流程。
   - 樣板是 `~/.agents/templates/task.md`，必要的二級標題為 `## Goal`／`## Scope`／`## Completion criteria`。`code_change: true` 時，在 Completion criteria 下寫 `### Acceptance cases`，每條包含 Given／When／Then 與一行 Verify 指令（放在 code span 內）。UI 行為的驗證方式見 [evidence.md](evidence.md#validation-command)。
4. 用 `task-init --paths <這次會碰到的路徑>` 建立 task。回傳內容：
   - plan、`readiness`、`next`
   - `context`：相關的專案文件、記憶，以及改過同一批路徑的已結案 task

   Managed 開發任務在建立 task 時一併記錄剛取得的規格確認，參數與適用條件依 [risk-flags.md](risk-flags.md#意圖確認)。

   `readiness.ready` 為 false 時先處理 blockers。開發前先讀 context 列出的文件與記憶。

   跨模組，或涉及契約、資料、狀態與失敗恢復的修改，接著依 [expansion.md](../implementation-spec/expansion.md) 把規格展開到可直接實作。若發現規格缺口，先補 task.md，必要時更新分類，實質規格變更回到第 3 步重新確認，intent 確認依 [risk-flags.md](risk-flags.md)。

   有 `doc_gap` 時，依 [project-docs](../project-docs/SKILL.md) 為這次碰到的模組補一份文件。分類補充（含 `task_type: mechanical` 的適用條件）見 [capability-selection.md](capability-selection.md#task_type-mechanical)。
5. 實作前判斷工作能否獨立完成；適合平行時使用平台原生 subagent，明確分配責任範圍，由主 agent 整合並驗證結果；worker 數量與隔離方式由 agent 依任務及平台能力決定。找呼叫點、讀檔彙整這類不需判斷的唯讀查證派給 [reader](../../agents/reader.md)；需要判斷的複審依 [review.md](review.md)。plan 的 `checklist` 是實作與 review 都要涵蓋的分析項目；`proofs` 和驗收案例一樣，要用 `evidence-run` 實際執行。註解依入口文件的「程式碼註解」觸發規則；worker 的指派範圍符合條件時，訊息附上 [clean-comments](../clean-comments/SKILL.md) 路徑。安裝、同步、部署、migration、provisioning 或外部整合時，另讀 [operational-verification](../operational-verification/SKILL.md)。
6. 之後照每個指令輸出的 `next` 補上 gate 缺口；驗證、Reviewer 與結案順序依 [Finalization](evidence.md#finalization)，證據有效性依同檔的 freshness 說明。
7. bug 修好或 review 確認問題後，依 [root-cause](../root-cause/SKILL.md) 補上防止再發生的測試、文件、規範或 workflow 修正。使用者做的決策、更正與可重用結論，依 [learn](../learn/SKILL.md) 記錄。

## 指令卡

task 狀態一律經由下列指令寫入。`<task>` 是 task 目錄，也可以給其中的 task.md。參數錯誤時，錯誤訊息會列出合法參數。

- 建立：`echo '<分類 JSON>' | agent-workflow task-init --task-path <task> --repo-root <repo> --paths <path1,path2>`。使用者已確認規格時加上 `--confirmed-by <確認來源> --as-user`。規格在計畫檔時，同一次 shell 呼叫先執行 `cp <計畫檔> <task>/task.md` 再建立。
- intent 變動後重新確認：`agent-workflow approve-intent --task-path <task> --confirmed-by <確認來源> --as-user`
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
