# Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag。可用值與機械觸發清單以 `schemas/task.schema.json` 為準。

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`、`test_integrity`、`security`、`operational`

「只重構內部結構」的判斷改由 `task_type: refactor` 單一入口承載，`## Behavior invariants and before-after evidence` 段落改依 `task_type` 觸發（見 [SKILL.md](SKILL.md) 第 4 節）。

| Flag | 定義（什麼情況標記） | 對應要求 |
|---|---|---|
| `behavior_change` | 使用者可觀察到的行為或輸出會改變 | 補完整驗收條目（`## Completion criteria` 下的 `### Acceptance cases`） |
| `ui` | 修改畫面、互動或前端行為 | 強制 `reviewer`；Review 使用平台原生 browser 實際驗證 |
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
| `security` | 修改認證、秘密處理、輸入信任邊界、指令執行或檔案路徑邊界 | 強制 `security_review` 與 `reviewer`，補 Security review |
| `operational` | 修改部署、runtime 設定、服務啟動、網路或 CI/CD 執行路徑 | 強制 `operational_verification` capability，補 Operational verification |

## 對抗式複查與 Mutation check 觸發

`financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 六個旗標是把對抗式複查要求（推翻資料溯源、底層語意或同型擴散假設）寫進 reviewer 指令的訊號。Runtime contract 只認得 `role.reviewer` 一種身份，不存在第二位 reviewer，因此這些要求併進同一位 reviewer 的指令，修正後重跑同一個 reviewer capability。

表格右欄的 freeze-required 與額外段落是**單向宣告**：flag 一旦填上就生效，沒有「補了某種證據就自動解除」這回事，capability 的執行結果也不會抑制它。判斷錯了要移除 flag，唯一路徑是明確重新分類：`agent-workflow reclassify --confirmed-by-user <文字> --reason <文字>`，runtime 會把這筆決定記進 `workflow_decision`；一般 `task-write` 會拒絕移除既有 `risk_flags`，直接編輯 `task.json` 更是被 hook fail-closed 擋下。移除 flag 時連同對應段落一併移除。`financial`／`irreversible` 命中時 runtime 強制 `mutation_validation`，其中 MV3 就是 mutation check；一般 `data_write` 由 `data_impact` 涵蓋，需要 mutation 驗證時用 `workflow_request` 自行加選。`authorization`／`security` 強制 `security_review`，`operational` 強制 `operational_verification`。capability 觸發集合以 `schemas/workflow-policy.json` 的 `require_when` 為權威來源，freeze 觸發集合仍以 `schemas/task.schema.json` 的 `x_agent_workflow` 為準。

## Freeze-required 詳細規則

命中 `contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements` 任一值時：

- Task 增加段落：現況與影響面、方案與取捨、邊界與異常、使用者確認；另在 `## Scope` 下補 `### Non-goals and compatibility`、在 `## Completion criteria` 下補 `### Acceptance cases`。這兩段刻意放在 `intent_hash` 涵蓋的段落之內，使用者批准的非目標與驗收案例才不會在批准後被改掉而雜湊不變。
- `contract`／`schema`／`data_write`／`financial`／`migration` 另補 `Contract and data impact`。
- `cross_feature`／`migration`／`irreversible` 另補 `Implementation sequence`（實作順序、依賴與回滾點）。
- 沒有另一個「解凍」狀態要維護：task-gate 只在通過時比對 `intent_approval.intent_hash` 是否等於當下 task.md 的 Goal／Scope（含 Non-goals and compatibility）／Completion criteria（含 Acceptance cases）三段內容的雜湊（不含其他 section，補證據、修錯字不受影響）。取得使用者對目標、非目標與完成條件的確認後，執行 `approve-intent --confirmed-by <who> --as-user`（runtime 自己算雜湊、寫入 `intent_approval`），task-gate 才會放行；之後只要這三段內容再變動，這個雜湊就立刻對不上，task-gate 重新擋下，必須重新 `approve-intent`——不需要、也沒有另一個 lifecycle status 來標記「已凍結／已解凍」。
- 通過雜湊比對前不得修改目標、非目標或完成條件；需求變更時 supersede 舊 task 並建立新 task。唯一例外（coordinator 編排中只縮減交付範圍）定義在 [orchestration.md](orchestration.md)。

## unclear_requirements 的釐清流程

在正式 code task 或前期的需求討論、問答與概念發想中，只要遇到需求籠統或未明（命中 `unclear_requirements` 語意情境）：
1. 先用 `planning` skill 釐清目標、限制與成功標準，梳理出初步架構與方向。
2. 若計畫或假設仍有較高風險、分支未明或涉及重大決策，主動加開 `grill-me` skill 逐一提問、壓力測試計畫與假設。
3. Code task 需取得使用者對目標、非目標與完成條件的明確確認後才能解除凍結（執行 `approve-intent`，寫入 `intent_approval.intent_hash`）；純討論／規劃則藉此收斂至具體可行的下一步。不必每次都跑兩個：`planning` 足以釐清就直接繼續；只有計畫或假設仍有風險、需要進一步逼問時才加開 `grill-me`。
