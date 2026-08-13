# Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`external_input`、`data_write`、`security`、`refactor`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

| Flag | 定義（什麼情況標記） | 對應要求 |
|---|---|---|
| `behavior_change` | 使用者可觀察到的行為或輸出會改變 | 補完整驗收條目（Acceptance cases） |
| `ui` | 修改畫面、互動或前端行為 | 使用平台原生 browser 實際驗證；若不執行 Verifier，由主 agent 完成並記錄 |
| `external_input` | 處理來自使用者或外部系統的輸入 | 檢查輸入驗證、授權、注入與敏感資料 |
| `security` | 涉及認證、授權、加密或敏感資料保護 | 檢查輸入驗證、授權、注入與敏感資料 |
| `data_write` | 會寫入或修改持久化資料 | 檢查交易、一致性、並發、冪等與回滾 |
| `refactor` | 只重構內部結構、不改變外部行為 | 記錄行為不變條件與 before/after 證據 |
| `contract` | 修改對外 API、介面或函式簽章 | freeze-required；補 Contract and data impact |
| `schema` | 修改資料結構（DB schema、訊息格式、設定檔結構） | freeze-required；補 Contract and data impact |
| `financial` | 涉及金額、賠付、計費等金流邏輯 | freeze-required；補 Contract and data impact |
| `authorization` | 修改權限或存取控制邏輯 | freeze-required |
| `cross_feature` | 一次改動影響多個功能或模組 | freeze-required；補 Implementation sequence（實作順序、依賴與回滾點） |
| `migration` | 需要資料或版本遷移 | freeze-required；補 Contract and data impact、Implementation sequence |
| `irreversible` | 改動無法簡單回滾（例如刪除資料、發送外部通知） | freeze-required；補 Implementation sequence |
| `unclear_requirements` | 需求本身不明確，需先與使用者釐清才能動工 | freeze-required |

## Adversarial 複查觸發

`financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 六個旗標任一命中時，除了下方 freeze-required 規則外，Reviewer PASS 後、Verifier 之前另加開一輪 `agent-workflow-adversarial` 複查（見 [SKILL.md](SKILL.md) 第 6a 節）。這六個旗標的共通點是「巧合正確或假設錯誤的代價高」，Reviewer 的確認式審查不足以攔下這類問題，需要一個心態相反、專找漏洞的獨立角色。權威清單是 `schemas/task.schema.json` 的 `x_agent_workflow.adversarial_required`，收尾 gate 會要求 `## Adversarial result` 有 `- result: PASS` 與四項檢查結論。

## Mutation check 觸發

`financial`／`data_write` 命中時，`Validation results` 另需 `- mutation check: PASS | SKIP`（SKIP 需 `- mutation reason:`）。權威清單是 schema 的 `x_agent_workflow.mutation_check_required`。理由是「測試全綠」多次等於「斷言從沒真的跑過」——內嵌字面值被編碼弄壞讓比對恆真、fixture 寫死成通過的形狀讓案例無法失敗；把關鍵判斷改壞、確認測試變紅，是最便宜的辨別方式。

## Freeze-required 詳細規則

命中 `contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements` 任一值時：

- Task 增加段落：非目標與相容性、現況與影響面、方案與取捨、邊界與異常、驗收案例、使用者確認。
- `contract`／`schema`／`data_write`／`financial`／`migration` 另補 `Contract and data impact`。
- `cross_feature`／`migration`／`irreversible` 另補 `Implementation sequence`（實作順序、依賴與回滾點）。
- 凍結後不得修改目標、非目標或完成條件；需求變更時 supersede 舊 task 並建立新 task。
- 唯一例外：coordinator 編排中由使用者發起、**只縮減**交付範圍的變更，依 [orchestration.md](orchestration.md) 原地更新並重填 `frozen_at`，不走 supersede（編排中途 supersede 會讓 worker 的 `parent_task_id` 指向失效 task）。其餘 freeze 後的需求變更仍須 supersede。

## unclear_requirements 的釐清流程

命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標、限制與成功標準，產出方向後再視需要用 `grill-me` skill 逐一提問、壓力測試計畫與假設，取得使用者明確確認後才能解除凍結、改為 `in_progress`。不必兩個都跑：`planning` 足以釐清就直接繼續；只有計畫或假設仍有風險、需要進一步逼問時才加開 `grill-me`。
