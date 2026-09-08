# Reviewer

只有 `reviewer` 進入 `selected` 時才讀本檔。

`reviewer` 是獨立的唯讀複審角色：只讀 diff 與相關程式碼並回報結論，本身不改動任何檔案，可以派成 subagent。主對話是 coordinator，負責整合複審結果並做最後一次合理性核對；coordinator 這一趟屬於整合工作，不算第二位 reviewer。

Runtime contract 只認得 `role.reviewer` 一種身份，第二位 reviewer 就算真的跑了也無法被證明，因此高風險情境改成把對抗式要求寫進同一位 reviewer 的指令。reviewer 回報 blocker 並修正後，重新執行同一個 reviewer capability。

## 執行方式

reviewer 與 coordinator 兩趟盲點互補：獨立 reviewer 抓得到主對話因為熟悉而略過的死碼與慣例偏離，coordinator 抓得到 reviewer 缺少專案脈絡而串不起來的跨檔案語意問題。

reviewer 這一趟派一般 subagent（`general-purpose`），只讀已穩定的 delivery diff 與 shared evidence map，指令載明兩項要求：

- 核對既有的相關測試是否足以支撐結論；只有測試範圍、新修改、環境或 finding 使既有結果不再有效時才實際重跑。數值、邊界與併發行為若現有測試沒有涵蓋，列為測試缺口並指出應補的具體案例，由實作者依 TDD 補齊。
- 對改動的欄位與資料流，往上下游追到 repository 與 entity，確認欄位映射、呼叫端與程式宣稱的行為一致。

高風險分類把要主動推翻的假設直接寫進同一位 reviewer 的指令：

- `financial`／`data_write`／`schema`／`migration`／`irreversible`：推翻資料 provenance、rollback 路徑與 invariants。
- `security`／`authorization`：推翻 trust boundary 與權限假設。
- `contract`：主動尋找 consumer 的相容性破口。
- `ui`：用平台原生 browser 實際驗證，不以靜態閱讀代替。

coordinator 這一趟由主對話對照完整 diff 與 shared evidence map，聚焦 subagent 缺乏專案脈絡而判斷不了的部分：與既有慣例是否一致、跨檔案的語意衝突、本次改動與既有功能是否重複或互相覆蓋。已由 shared map 證實的搜尋與測試結果直接引用，不重新建立相同脈絡。

## 結果回填

`templates/task-minimal.md` 不預先帶 `## Reviewer result`；reviewer 進入 `selected` 時才在 task.md 補上這一段。

各趟結果合併寫入 `## Reviewer result`：`- result:` 記 PASS 或 FAIL，`- findings:` 只列 blocker，每項附 path、symbol／hunk、可觸發情境、影響與最小修正方向；沒有 blocker 時 findings 記 none。

- Review 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task。
- 回填後的 task 路徑即為唯一版本，後續複審與 knowledge 回寫都以它為準。
- 有 blocker 時主對話修正、重新執行相關驗證，再重跑上述各趟。

subagent 回報只保留錯誤：有 finding、blocker、FAIL 或未驗證限制時，輸出具體錯誤、依據、影響與可重現位置，省略所有 PASS 項目；全部通過時只輸出單行 `PASS`。輸出不設固定 token 截斷。

## Review round 與增量錨定

第一輪建立完整脈絡，`## Review round` 只有 `- round:` 與 `- unverified nodes:`。Blocker 修正後，第二輪起在該段補記 `- prior findings:`、`- fix delta:`、`- impact delta:`、`- validation delta:` 與 `- cause:`；可用它導航，但仍須自行核對 diff，task 敘述不是正確性證據。

開下一輪前先做歸因：這次被打回，是當初缺文件、任務描述沒講清楚、慣例沒寫成規範、有文件規範但沒讀到，還是單純寫錯。執行 `agent-workflow review-cause --action Record --task-path <task> --round <n> --cause <cause> --evidence <當初缺的是什麼> --paths <本次改動路徑>`，把回傳的 id 填進該輪的 `- cause:`。分類定義與累積後的補救路由見 `schemas/review-cause.schema.json` 與 [distill skill](../distill/SKILL.md)。

後續輪次採 delta-first：先檢查修復項、直接呼叫端與本輪新增波及項，不重複輸出未變更內容。若修改入口、公開介面、共用狀態、資料／契約、並發／非同步／錯誤邊界，或前輪存在未確認節點，則重新展開完整 execution path。Diff anchor 使用 repo-relative path、symbol 與 diff hunk，行號只作輔助。
