<!-- 範例：一個最小的重軌驗收清單。實際使用時複製 kit/templates/checklist.md 到
     ~/.claude/projects/<project-slug>/acceptance/<task-slug>/checklist.md
     每條溯源同目錄 spec.md 的 S<n>，見 spec.md 範例與 kit/acceptance-spec.md -->

# 範例任務：健康檢查端點
- project: C:\path\to\your\project
- frozen: 2026-07-20

### A1 單元測試通過
- spec: S1
- test-type: 規格逐條
- given: 服務已啟動
- when: 執行單元測試套件
- then: health 套件測試全數通過
- cmd: `go test ./internal/health/... -run TestHealthz -v`
- expect: `ok\s+`
- status: [ ]

### A2 /healthz 回 200
- spec: S1
- test-type: 規格逐條
- given: 本地 server 已在 8899 port 啟動
- when: GET /healthz
- then: 回應 HTTP 200
- setup: 需先啟動本地 server（port 8899）
- cmd: `curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8899/healthz`
- expect: `200`
- status: [ ]

### A3 依賴服務中斷時回 503（異常路徑範例）
- spec: S1
- test-type: 異常路徑
- given: 本地 server 已啟動但資料庫連線中斷
- when: GET /healthz
- then: 回應 HTTP 503，不回 200 假裝健康
- setup: 需先啟動本地 server 並手動斷開資料庫連線
- cmd: `curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8899/healthz`
- expect: `503`
- status: [ ]

### A4 首頁顯示版本號（前端型範例）
- spec: S2
- test-type: 規格逐條
- given: 使用者開啟首頁
- when: 捲動到頁尾
- then: 頁尾顯示 v 開頭的版本字串
- type: ui
- steps: 開啟 http://127.0.0.1:8899/ → 捲動到頁尾
- expect: 頁尾顯示 v 開頭的版本字串
- status: [ ]

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此）
