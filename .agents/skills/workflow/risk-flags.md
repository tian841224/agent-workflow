# Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag。可用值與機械觸發清單以 `schemas/task.schema.json` 為準。

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`、`test_integrity`

「只重構內部結構」的判斷改由 `task_type: refactor` 單一入口承載，`## Behavior invariants and before-after evidence` 段落改依 `task_type` 觸發（見 [SKILL.md](SKILL.md) 第 4 節）。

| Flag | 定義（什麼情況標記） | 對應要求 |
|---|---|---|
| `behavior_change` | 使用者可觀察到的行為或輸出會改變 | 補完整驗收條目（Acceptance cases） |
| `ui` | 修改畫面、互動或前端行為 | Review 使用平台原生 browser 實際驗證 |
| `data_write` | 會寫入或修改持久化資料 | 檢查交易、一致性、並發、冪等與回滾 |
| `contract` | 修改對外 API、介面或函式簽章 | freeze-required；補 Contract and data impact |
| `schema` | 修改資料結構（DB schema、訊息格式、設定檔結構） | freeze-required；補 Contract and data impact |
| `financial` | 涉及金額、賠付、計費等金流邏輯 | freeze-required；補 Contract and data impact |
| `authorization` | 修改權限或存取控制邏輯 | freeze-required |
| `cross_feature` | 一次改動影響多個功能或模組 | freeze-required；補 Implementation sequence（實作順序、依賴與回滾點） |
| `migration` | 需要資料或版本遷移 | freeze-required；補 Contract and data impact、Implementation sequence |
| `irreversible` | 改動無法簡單回滾（例如刪除資料、發送外部通知） | freeze-required；補 Implementation sequence |
| `unclear_requirements` | 需求本身不明確，需先與使用者釐清才能動工 | freeze-required |
| `test_integrity` | 刪除或弱化既有測試斷言、skip／disable 既有測試、或大量改動 snapshot／fixture | 強制 `test_integrity` capability，補 Test integrity |

## 對抗式複查與 Mutation check 觸發

`financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 六個旗標是主對話在 Review 指令裡加入對抗式複查（推翻資料溯源、底層語意或同型擴散假設）的重要訊號，不會另外觸發獨立角色。

表格右欄的 freeze-required 與額外段落是**單向宣告**：flag 一旦填上就生效，沒有事後解除機制——判斷錯了就編輯 task 拿掉該 flag（連同對應段落一併移除），而不是靠某種證據去抑制它。`financial`／`data_write` 命中時另需 mutation check；觸發集合以 `schemas/task.schema.json` 的 `x_agent_workflow` 為權威來源。

## Freeze-required 詳細規則

命中 `contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements` 任一值時：

- Task 增加段落：非目標與相容性、現況與影響面、方案與取捨、邊界與異常、驗收案例、使用者確認。
- `contract`／`schema`／`data_write`／`financial`／`migration` 另補 `Contract and data impact`。
- `cross_feature`／`migration`／`irreversible` 另補 `Implementation sequence`（實作順序、依賴與回滾點）。
- 沒有另一個「解凍」狀態要維護：task-gate 只在通過時比對 `intent_approval.intent_hash` 是否等於當下 task.md 的 Goal／Scope／Completion criteria 三段內容的雜湊（不含其他 section，補證據、修錯字不受影響）。取得使用者對目標、非目標與完成條件的確認後，執行 `approve-intent --confirmed-by <who> --as-user`（runtime 自己算雜湊、寫入 `intent_approval`），task-gate 才會放行；之後只要這三段內容再變動，這個雜湊就立刻對不上，task-gate 重新擋下，必須重新 `approve-intent`——不需要、也沒有另一個 lifecycle status 來標記「已凍結／已解凍」。
- 通過雜湊比對前不得修改目標、非目標或完成條件；需求變更時 supersede 舊 task 並建立新 task。唯一例外（coordinator 編排中只縮減交付範圍）定義在 [orchestration.md](orchestration.md)。

## unclear_requirements 的釐清流程

在正式 code task 或前期的需求討論、問答與概念發想中，只要遇到需求籠統或未明（命中 `unclear_requirements` 語意情境）：
1. 先用 `planning` skill 釐清目標、限制與成功標準，梳理出初步架構與方向。
2. 若計畫或假設仍有較高風險、分支未明或涉及重大決策，主動加開 `grill-me` skill 逐一提問、壓力測試計畫與假設。
3. Code task 需取得使用者對目標、非目標與完成條件的明確確認後才能解除凍結（執行 `approve-intent`，寫入 `intent_approval.intent_hash`）；純討論／規劃則藉此收斂至具體可行的下一步。不必每次都跑兩個：`planning` 足以釐清就直接繼續；只有計畫或假設仍有風險、需要進一步逼問時才加開 `grill-me`。
