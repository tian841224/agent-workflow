# Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag。可用值與機械觸發清單以 `schemas/task.schema.json` 為準；本檔只提供判斷與使用說明。

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

「只重構內部結構」的判斷改由 `change_kind: refactor` 單一入口承載，`## Behavior invariants and before-after evidence` 段落改依 `change_kind` 觸發（見 [SKILL.md](SKILL.md) 第 4 節）。

| Flag | 定義（什麼情況標記） | 對應要求 |
|---|---|---|
| `behavior_change` | 使用者可觀察到的行為或輸出會改變 | 補完整驗收條目（Acceptance cases） |
| `ui` | 修改畫面、互動或前端行為 | Verifier 使用平台原生 browser 實際驗證 |
| `data_write` | 會寫入或修改持久化資料 | 檢查交易、一致性、並發、冪等與回滾 |
| `contract` | 修改對外 API、介面或函式簽章 | freeze-required；補 Contract and data impact |
| `schema` | 修改資料結構（DB schema、訊息格式、設定檔結構） | freeze-required；補 Contract and data impact |
| `financial` | 涉及金額、賠付、計費等金流邏輯 | freeze-required；補 Contract and data impact |
| `authorization` | 修改權限或存取控制邏輯 | freeze-required |
| `cross_feature` | 一次改動影響多個功能或模組 | freeze-required；補 Implementation sequence（實作順序、依賴與回滾點） |
| `migration` | 需要資料或版本遷移 | freeze-required；補 Contract and data impact、Implementation sequence |
| `irreversible` | 改動無法簡單回滾（例如刪除資料、發送外部通知） | freeze-required；補 Implementation sequence |
| `unclear_requirements` | 需求本身不明確，需先與使用者釐清才能動工 | freeze-required |

## Adversarial 複查與 Mutation check 觸發

`financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 六個旗標任一命中時，所有 `code_change: true` task 都加開原生 `agent-workflow-adversarial` 複查；`financial`／`data_write` 命中時另需 mutation check。觸發集合以 `schemas/task.schema.json` 的 `x_agent_workflow` 為準。

## Freeze-required 詳細規則

命中 `contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements` 任一值時：

- Task 增加段落：非目標與相容性、現況與影響面、方案與取捨、邊界與異常、驗收案例、使用者確認。
- `contract`／`schema`／`data_write`／`financial`／`migration` 另補 `Contract and data impact`。
- `cross_feature`／`migration`／`irreversible` 另補 `Implementation sequence`（實作順序、依賴與回滾點）。
- 凍結後不得修改目標、非目標或完成條件；需求變更時 supersede 舊 task 並建立新 task。唯一例外（coordinator 編排中只縮減交付範圍）定義在 [orchestration.md](orchestration.md)，本檔不重述。

## unclear_requirements 的釐清流程

命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標、限制與成功標準，產出方向後再視需要用 `grill-me` skill 逐一提問、壓力測試計畫與假設，取得使用者明確確認後才能解除凍結、改為 `in_progress`。不必兩個都跑：`planning` 足以釐清就直接繼續；只有計畫或假設仍有風險、需要進一步逼問時才加開 `grill-me`。
