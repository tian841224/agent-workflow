# Capability selection

實際會選到哪些 capability，一律以 `task-init`／分類型 `task-write` 回傳的 compiled plan 為準；本檔只定義各欄位的意義與不可繞過的邊界。

## Plan 欄位

- **`required`**：runtime 依 `schemas/workflow-policy.json` 的 `require_when` 算出的下限，由 `code_change`／`task_type`／`impact_scope`／`impact_effect`／`impact_confidence`／`risk_flags` 決定。`code_change: true` 的 task 一律需要 Reviewer；`task_type: mechanical` 只免除這條，其他 `require_when` 條件（影響面、effect、risk flag）仍會選入 Reviewer。
- **`requested`**：主對話依已知需求寫進 `workflow_request` 的額外 capability，只能疊加。少填 `workflow_request` 不會讓 `required` 的項目消失。
- **`selected`**：`required` ∪ `requested`。
- **`proofs`**：selected capability 中必須由 runtime 實際執行的 step，每一條都要有 `evidence-run` 紀錄。
- **`checklist`**：selected capability 中其餘的分析 step，是實作與 Reviewer 要涵蓋的項目，不在 gate 裡。`workflow_facts` 沒宣告而判斷不了的 step 不會被略過：分析 step 留在 checklist，runtime step 仍列在 `proofs`。這類 step 會附上 `undecided_by`，用 `task-write` 宣告其中的 fact 後，就能確定它是否適用。
- **`required_evidence`**：gate 驗收的 id，也就是 `proofs` 加上角色（`role.reviewer`）。驗收案例 `acceptance.<ID>` 由 task.md 決定，gate 另外檢查。
- `suggested` 是依分類產生的候選建議，不進 gate。

`plan_hash` 只涵蓋 selected capability、`required_evidence` 與 exploration profile。policy 或分類改了，但這三者沒變時，既有 evidence 仍然有效。

## 移除 required 的唯一路徑

`agent-workflow waive --task <task> --requirement-id <被豁免的 requirement> --confirmed-by-user <文字>`。waiver 同時綁定當下的 `plan_hash` 與 `plan_revision`，分類一變就會失效。驗收案例不能 waive；要改驗收標準，就修改 task.md，然後重新驗收。

## 分類不完整

`classification_incomplete` 列出因為缺了某個分類欄位，所以無法判斷是否需要強制執行的 capability，以及缺少的欄位名稱。gate 會擋下這種 task，直到欄位補齊。

## 分類更新

後續分類一律用 `task-write` 更新。移除既有 `risk_flags`，或把 `managed_change` 從 true 降為 false，只能走 `reclassify`，並附上使用者確認與原因。調低 `impact_confidence` 會增加 gate 要求，可以直接用 `task-write`。分類更新會回傳新的 plan；未知的 capability 名稱或無效的 `workflow_facts` 會回報 contract error。
