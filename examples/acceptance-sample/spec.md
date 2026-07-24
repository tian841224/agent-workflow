<!-- 範例：與 checklist.md 同目錄的 SDD 規格書。實際使用時複製 templates/spec.md 到
     ~/.claude/projects/<project-slug>/acceptance/<task-slug>/spec.md -->

# 範例任務：健康檢查端點 — 規格書（spec.md）
- project: C:\path\to\your\project
- frozen: 2026-07-20

## 商業規格（PM，R1 產出）

### 目標

讓維運與監控系統能可靠判斷服務是否存活、依賴是否正常。

### 範圍 / 非目標

- 範圍: 新增 `/healthz` 端點與首頁版本號顯示
- 非目標: 不含詳細依賴健康度儀表板，只回覆存活與否

### S1 健康檢查端點回報服務與依賴狀態
- 輸入: GET /healthz，無參數
- 輸出: HTTP 200（服務與依賴皆正常）或 HTTP 503（任一關鍵依賴異常）
- 邊界與錯誤處理: 資料庫連線中斷時必須回 503，不得因為 handler 本身還活著就誤報 200
- Given: 服務已啟動
- When: 呼叫 GET /healthz
- Then: 依實際依賴狀態回對應 HTTP code

### S2 首頁顯示目前版本號
- 輸入: 使用者開啟首頁
- 輸出: 頁尾顯示 `v` 開頭的版本字串
- 邊界與錯誤處理: 版本號讀取失敗時顯示 `v-unknown`，不留白、不噴錯誤畫面
- Given: 使用者開啟首頁
- When: 捲動到頁尾
- Then: 看到目前部署版本號

## 釐清紀錄

- Q: 版本號讀不到時要顯示什麼？
- A: 顯示 `v-unknown`，不要噴錯誤畫面
- 定案: 寫入 S2 的「邊界與錯誤處理」

## 技術規格（architect，R2 產出）

- API / 介面 contract: `GET /healthz` → `200 {}` / `503 {"reason": string}`
- 資料型別: 無請求參數；回應 body 僅 503 時帶 `reason` 字串
- 錯誤碼定義: 503 的 `reason` 固定值 `db_unreachable`，供監控告警比對
- 架構與模組劃分: `internal/health` 套件新增 handler，依賴既有 DB ping 介面
- 測試策略與 TDD seam: seam = `health.CheckDB(ctx) error`，先寫 DB 中斷情境的失敗測試（red）再實作 handler 判斷邏輯（green）
- 非功能性需求門檻: 回應時間 < 100ms（不含依賴逾時本身）；不適用安全/相容性/無障礙項目，理由：純內部監控端點、無使用者介面互動
- 建議測試項目補充: DB 中斷（異常路徑，見 checklist A3）、連續呼叫是否會被誤判為攻擊而限流（等價類，視該專案 rate-limit 設定決定是否需要）

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此，一行一筆：日期 | 變更 | 核准依據）
