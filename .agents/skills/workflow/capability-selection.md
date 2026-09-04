# Capability selection

Runtime 依 `risk_flags` 透過 `workflow-policy.json` 的 `require_when` 算出一組 `required` capability，這是不可省略的下限；主對話依已知需求與程式脈絡，在 `workflow_request` 裡疊加想額外執行的 capability，只能加、不能拿掉 `required` 命中的項目。單純不把某個 capability 寫進 `workflow_request` 並不會讓它從 gate 消失——`required` 由 risk flags 直接算出，要移除只能明確執行 `waive`（需 `--requirement-id <被豁免的 requirement>` 與 `--confirmed-by-user`），而這個 waiver 綁定當下的 `plan_hash`，task 的分類一變（risk flags、`impact_scope`、`impact_effect` 等任何進到 hash 的欄位改變）就自動失效，需重新確認。

**外層選取（跑哪些 capability）**：Planner 先依 task metadata 與 `workflow_facts` 產生 `suggested` 候選，主對話再確認、覆寫或補充，寫入 `workflow_request`；runtime 再把 `required` 與 `workflow_request` 合併成最終 `selected`。`required` 為空時任何組合都合法——只跑 evidence capability 而沒有 `reviewer`、或一個都不跑（此時 `## Impact surface` 必填，說明為何判斷這個 task 不需要任何 capability），都是正常結果；`required` 非空時，`selected` 至少涵蓋這些項目，`workflow_request` 只能疊加、不能覆寫。

**交付批次與角色時機**：角色以一個 task 的最終可交付 diff 為單位選取與執行。任務拆成多個實作階段時，各階段只完成其局部測試與必要驗證；待所有階段整合、完成條件與完整 execution path 穩定後，才對整體變更集執行 Review。若某階段會獨立發布、不可逆地寫入外部系統，或其產物已成為後續階段不可回溯的前提，則將它視為獨立交付批次並在該批次完成前執行必要角色。finding 修正後依 §6b 做 delta-first 複查；只有入口、公開介面、共用狀態、資料／契約、並發／非同步或錯誤邊界改變時，才重新展開完整路徑。

**內層選取（跑該 capability 的哪些 step）**：capability 一旦被選中，它底下哪些 step 需要填，由 policy 內每個 step 的 `when` 依 `impact_scope`／`impact_effect`／`task_type`／`risk_flags`／`workflow_facts` 這組宣告值決定。例如 `execution_path_review` 在 `impact_scope: file` 且 `task_type: fix` 時只需要 EP1，在 `impact_scope: cross_project` 且 `task_type: refactor` 時展開 EP1–EP5。這一層只會**減少**要寫的 evidence 行數，不會影響最終 capability 是否被選中——最終選取仍以 `workflow_request` 為準。`workflow_facts` 裡沒宣告的欄位一律保留對應的 step（unknown 不等於「不需要」），但已宣告為真的 fact 可以產生 capability 候選建議。`order_after` 只決定順序，不會把缺席的前置補回來。完整的 step 清單與 `when` 條件見 `schemas/workflow-policy.json`。

Evidence capability 只在影響確實擴散時才登場，一般 code change 的成本很低：

| 情境 | 典型組合 | evidence step 數 |
|---|---|---|
| 單檔 bug fix、模組內小功能 | `reviewer` | 0 |
| 判斷為 isolated 的小改動（例如無 consumer 的 additive 欄位） | 無 capability ＋ `Impact surface` 說明判斷依據 | 0 |
| 邏輯單純但需實測、無呼叫端 | `reviewer` | 0 |
| 純測試變更命中 test integrity risk | `test_integrity` | 3 |
| 跨模組 refactor | `execution_path_review` → `regression_validation` → `reviewer` | 10 |
| 金流狀態機 | `data_impact` → `execution_path_review` → `regression_validation` → `reviewer` | 14 |
| 大表 migration + backfill | `execution_path_review` → `schema_compatibility` → `data_impact` → `migration_safety` → `reviewer` | 20 |
| coordinator／worker | 依上列規則，另加 orchestration 與 legacy close gate（見 [elevated.md](elevated.md)） | 依上列規則 |

Reviewer 用於判斷完整 diff 是否符合需求、影響面與失敗模式，並從 real entrypoint 確認完成條件與可觀察結果。命中 `financial`、`data_write`、`migration`、`irreversible`、`schema`、`contract` 時，在 §6 第一趟的指令裡明寫要推翻的資料溯源、底層語意或同型擴散假設。每列都是最終交付批次的典型組合，不是逐一實作階段的 pipeline。

`workflow-plan` 會輸出 `required`、`classification_incomplete`、`suggested`、`requested`、`selected` 與 `order`，供主對話在建立或更新 task 前檢查候選。`classification_incomplete` 列出「因為某個分類欄位還沒填，所以無法判斷該不該強制」的 capability 與缺的欄位名稱；它不會被自動加進 `required`，但 task gate 會擋下來，要求先補齊分類再判斷。`workflow_request` 是主對話寫入、疊加在 `required` 之上的 capability 清單（例如 `[reviewer]`）；名稱 authority 是 `schemas/workflow-policy.json`，未知 capability 或無效 `workflow_facts` 直接回報 contract error。runtime 驗證的是 `required` ∪ `workflow_request` 合併後的 `selected` 清單執行結果是否齊全。沒有 `workflow_mode: main` 的既有 task（早於本機制的舊 task）不再走獨立的相容判斷：一律視為 `code_change: true` 就要求 `reviewer`，同樣沒有分別的流程分支。Retrospective 只在疑似 regression、同一問題反覆修正或使用者要求時啟動，不因每個 `fix` 自動加入。
