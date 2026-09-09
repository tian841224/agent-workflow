# Capability selection

實際會選到哪些 capability，一律以 runtime compiled plan 為準；優先重用 `task-init`／分類型 `task-write` 已回傳的 plan。只有目前沒有有效 compiled output 時才執行 `agent-workflow workflow-plan --task-path <path>`；本檔只定義各欄位的意義與不可繞過的邊界。

## 三個欄位

- **`required`**：runtime 依 `schemas/workflow-policy.json` 的 `require_when` 算出的下限。每個 `managed_change: true` task 固定包含 `delivery_validation`；其他 capability 由 `impact_scope`／`impact_effect`／`impact_confidence`／`risk_flags` 決定。單檔、局部行為、高信心且無高風險 flag 的修改只需要這份最低 runtime receipt。
- **`requested`**：主對話依已知需求與程式脈絡寫入 `workflow_request` 的額外項目，只能疊加。少填 `workflow_request` 不會讓 `required` 的項目消失。
- **`selected`**：`required` ∪ `requested`，也就是 gate 實際驗收的清單。

`suggested` 是 runtime 依 `workflow_facts` 產生的候選建議，不進入 gate。

## 移除 required 的唯一路徑

`agent-workflow waive --requirement-id <被豁免的 requirement> --confirmed-by-user <文字>`。該 waiver 同時綁定當下的 `plan_hash` 與 `plan_revision`：分類一變就自動失效，需重新確認。兩個條件都必要——`plan_hash` 是分類的純函式，分類改走一圈再改回來會還原同一個 hash，只比對 hash 會讓舊 waiver 復活。

## 分類不完整

`classification_incomplete` 列出「因為某個分類欄位還沒填，所以無法判斷該不該強制」的 capability 與缺的欄位名稱。它不會被自動加進 `required`，但 task gate 會擋下來。

step 層同理：`workflow_facts` 沒宣告的欄位會讓依賴它的 step 停在 unknown，列進 `step_classification_incomplete`，`managed_change: true` 的 task 會因此被 gate 擋下，直到補齊 missing 點名的欄位。unknown 不等於「不需要」，也不等於「要跑」。

## 內層 step 選取

capability 被選中後，它底下哪些 step 需要填，由 policy 內每個 step 的 `when` 依 `impact_scope`／`impact_effect`／`task_type`／`risk_flags`／`workflow_facts` 決定。這一層只會減少要寫的 evidence 行數，不影響 capability 是否被選中。`order_after` 只決定順序，不會把缺席的前置補回來。完整 step 清單與條件見 `schemas/workflow-policy.json`。

## 交付批次與角色時機

角色以一個 task 的最終可交付 diff 為單位選取與執行。任務拆成多個實作階段時，各階段只完成其局部測試與必要驗證；待所有階段整合、完成條件與完整 execution path 穩定後，才對整體變更集執行 Review。若某階段會獨立發布、不可逆地寫入外部系統，或其產物已成為後續階段不可回溯的前提，則視為獨立交付批次，在該批次完成前執行必要角色。

finding 修正後採 delta-first 複查（見 [review.md](review.md)）；只有入口、公開介面、共用狀態、資料／契約、並發／非同步或錯誤邊界改變時，才重新展開完整路徑。

未知 capability 名稱或無效 `workflow_facts` 一律回報 contract error，名稱 authority 是 `schemas/workflow-policy.json`。
