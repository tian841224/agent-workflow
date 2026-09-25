# Reviewer

只有 `reviewer` 進入 `selected` 時才讀本檔。`code_change: true` 的 task 都會選入 Reviewer。`task_type: mechanical` 只免除這條規則；影響面到 `multi_module` 以上、`impact_effect` 為 shared_behavior／data／contract／destructive，或帶有高風險 flag 時仍會選入。沒選入時，由主對話對照 acceptance 與 checklist 自我檢查。

`reviewer` 是獨立的唯讀複審角色，派成 subagent：只讀 diff 與相關程式碼並回報結論，不改動任何檔案。主對話是 coordinator，負責修正、整合複審結果，並做最後一次合理性核對；這一趟屬於整合工作，不算第二位 reviewer。Runtime contract 只認得 `role.reviewer` 一種身份，所以高風險情境的對抗式要求要寫進同一位 reviewer 的指令。

## Review timing

正式 Reviewer 以整個 task 的穩定交付為單位執行：所有 slices 完成、程式碼／測試／文件整合好，而且驗收案例與 proofs 的 `evidence-run` 都通過之後，才開第一輪。Slice 的 local feedback 是 coordinator 的實作回饋，不是正式 Reviewer。需要獨立發布、不可逆外部操作或不可回溯前提的範圍，建立獨立 task。

## 每一輪的流程

1. 在 repo root 執行 `agent-workflow pre-review --path <repo> --task-path <task>`。回傳 `workspace_sha256`，以及這一輪的 `review` brief：`round`、`scope`、`paths`、上一輪的 `previous`、`acceptance`、`checklist`、`risk_flags`。從快照到 `review-record` 之間工作樹保持不動，包括 stash/pop。
2. 派新的 reviewer subagent（Claude 用 `general-purpose`），訊息只帶下列內容：
   - brief 本身：`paths` 與 base、驗收案例、checklist
   - 這次強度要求的推翻假設（見下節）
   - 第 2 輪起加上 `previous` 的 findings

   完整背景與已確認的 PASS 不重複貼上。
3. reviewer 回報 finding、blocker、FAIL 或未驗證限制，每項附依據、影響與可重現位置（repo-relative path、symbol、diff hunk）；全部通過時回傳單行 `PASS`。
4. 主對話用 `review-record --expected-workspace-sha256 <sha>` 記錄結果。runtime 會自行計算 `reviewed_base`、`reviewed_paths`、`reviewed_diff_sha256` 與每個路徑的 digest；工作樹在快照後有變動，就拒絕這筆紀錄。
5. 有 blocker：主對話修正 → 重跑受影響的 `evidence-run` → 回到第 1 步。下一輪的 `scope` 是 `delta`，`paths` 只包含上一輪之後內容有變動的路徑。

## 強度依 brief 調整

- 所有輪次：核對既有測試與驗收案例是否足以支撐結論；只有測試範圍、新修改或 finding 使既有結果失效時，才實際重跑。數值、邊界與併發行為若沒有測試涵蓋，列為測試缺口並指出應補的具體案例。對改動的欄位與資料流，往上下游追到 repository 與 entity。
- `impact_scope: file`、brief 的 `risk_flags` 為空的修改：只看 diff、驗收案例與 checklist。
- 有 `risk_flags` 時，把要主動推翻的假設寫進指令：
  - `financial`／`data_write`／`schema`／`migration`／`irreversible`：推翻資料 provenance、rollback 路徑與 invariants。
  - `security`／`authorization`：推翻 trust boundary 與權限假設。
  - `contract`：主動尋找 consumer 的相容性破口。
  - `ui`：用平台原生 browser 實際驗證，不以靜態閱讀代替。
- 第 2 輪起只檢查三件事：上一輪的 findings 是否已修正、`paths` 列出的 delta，以及這些路徑的直接呼叫端。若修改碰到入口、公開介面、共用狀態、資料／契約、並發／非同步／錯誤邊界，或前一輪有未確認的節點，才重新展開完整的 execution path。

coordinator 這一趟對照完整 diff 與 evidence map，聚焦 subagent 缺乏專案脈絡而判斷不了的部分：與既有慣例是否一致、跨檔案的語意衝突，以及本次改動是否與既有功能重複或互相覆蓋。

## 結果回填與 freshness

Reviewer 結果只透過 `review-record` 寫入；summary 保留 blocker、path、symbol／hunk、可觸發情境、影響與最小修正方向。`agent-workflow task-report` 會把 role evidence 呈現給人閱讀。

下列任一情況都會讓既有 review 失效，需要重新複審：
- 已 review 範圍內的內容改變
- 交付新增了原本 `reviewed_paths` 沒有涵蓋的路徑
- 分類異動使 `plan_revision` 前進
- `reviewed_base` 已無法解析

Review 指出未列入的呼叫端、入口或共用狀態時，先補進 evidence map，重新評估是否要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍時補 `cross_feature`，並依 freeze 規則更新 intent 後重新 `approve-intent`，或 supersede 舊 task 另建新 task。

確認的 finding 依 [root-cause](../root-cause/SKILL.md) 追查起因。要立即留下歸因時，可在失敗回報附上：`review-record --result fail --cause-round <n> --cause <cause> --cause-evidence <當初缺的是什麼> --cause-paths <本次改動路徑>`。分類定義見 `schemas/review-cause.schema.json` 與 [distill skill](../distill/SKILL.md)。
