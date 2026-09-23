# Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`、`test_integrity`、`security`、`operational`

flag 會讓 runtime 強制對應的 capability，實際結果以 `task-init`／`task-write` 回傳的 compiled plan 為準；觸發集合的 authority 是 `schemas/workflow-policy.json` 的 `require_when`，freeze 觸發集合是 `schemas/task.schema.json` 的 `x_agent_workflow`。

## 什麼情況標記

| Flag | 定義 |
|---|---|
| `behavior_change` | 使用者可觀察到的行為或輸出會改變 |
| `ui` | 修改畫面、互動或前端行為 |
| `data_write` | 會寫入或修改持久化資料 |
| `contract` | 修改對外 API、介面或函式簽章 |
| `schema` | 修改資料結構（DB schema、訊息格式、設定檔結構） |
| `financial` | 涉及金額、賠付、計費等金流邏輯 |
| `authorization` | 修改權限或存取控制邏輯 |
| `cross_feature` | 一次改動影響多個功能或模組 |
| `migration` | 需要資料或版本遷移 |
| `irreversible` | 改動無法簡單回滾（例如刪除資料、發送外部通知） |
| `unclear_requirements` | 需求本身不明確，需先與使用者釐清才能動工 |
| `test_integrity` | 刪除或弱化既有測試斷言、skip／disable 既有測試、或大量改動 snapshot／fixture |
| `security` | 修改認證、秘密處理、輸入信任邊界、指令執行或檔案路徑邊界 |
| `operational` | 修改部署、runtime 設定、服務啟動、網路或 CI/CD 執行路徑 |

## 單向宣告

flag 一旦填上就生效，沒有「補了某種證據就自動解除」這回事，capability 的執行結果也不會抑制它。判斷錯了要移除 flag，唯一路徑是 `agent-workflow reclassify --confirmed-by-user <文字> --reason <文字>`，runtime 會把這筆決定記進 `workflow_decision`；一般 `task-write` 會拒絕移除既有 `risk_flags`。

## Freeze-required

命中 `contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements` 任一值時：

- 只在 `## Scope` 下補 `### Non-goals and compatibility`，在 `## Completion criteria` 下補 `### Acceptance cases`。這兩段位於 `intent_hash` 涵蓋的區域，使用者批准的非目標與驗收案例才不會在批准後被改掉而雜湊不變；影響面、方案與證據留在 task.json 的分類、plan 與 evidence。
- gate 比對 `intent_approval` 的 `intent_hash` 是否等於當下 task.md 的 Goal／Scope（含 Non-goals and compatibility）／Completion criteria（含 Acceptance cases）三段內容的雜湊；補證據、勾選 `-`／`*` 項目的 checkbox、只改空白或換行，以及修改其他段落都不受影響。這三段內任何非空白的內容修改（包括錯字）都會讓 attestation 與既有 evidence 過期，必須重新 `approve-intent` 並重新記錄 evidence，所以在記錄 evidence 前先把這三段定稿。
- 通過雜湊比對前，目標、非目標與完成條件維持不動；需求變更時 supersede 舊 task 並建立新 task。唯一例外（coordinator 編排中只縮減交付範圍）定義在 [orchestration.md](orchestration.md)。

### 意圖確認

- 先寫好 task.md 再 `task-init`。task 建立時（或之後的 `task-write` 首次加上 freeze-required flag 時）若 task.md intent 有效，runtime 直接寫入 agent attestation（`source: cli-attestation`、`confirmed_by: agent`），不需另跑指令，也不停下來請使用者確認。intent 無效時 `readiness` 會列出 blocker，修正 task.md 後執行 `approve-intent --confirmed-by agent`。
- 已存在的 attestation 不會自動更新；intent 變動後的重新確認一律明確執行 `approve-intent`。只有使用者在訊息中實際確認過這份 intent 時才用 `approve-intent --as-user` 升級為使用者確認，`--confirmed-by` 註明來源（例如 `user message`、`plan approval`）。
- agent 自行補上的非目標、刻意接受的風險取捨（例如不回滾、不冪等）或範圍調整，在開始實作的進度訊息中一句話列出差異，不等待回覆。

## unclear_requirements 的釐清流程

需求籠統或未明時：

1. 先用 [planning skill](../planning/SKILL.md) 釐清目標、限制與成功標準，梳理出初步架構與方向。
2. 計畫或假設仍有較高風險、分支未明或涉及重大決策時，加開 [grill-me skill](../grill-me/SKILL.md) 逐一提問、壓力測試計畫與假設。`planning` 足以釐清時就直接繼續。
3. Code task 釐清後先完成 task.md 再 `task-init`，由 runtime 依「意圖確認」記錄 attestation，不再另外要求使用者確認 intent。純討論或規劃則藉此收斂至具體可行的下一步。
