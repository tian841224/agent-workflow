<!-- 範例：一個最小的重軌驗收清單。實際使用時複製 kit/templates/checklist.md 到
     ~/.claude/projects/<project-slug>/acceptance/<task-slug>/checklist.md -->

# 範例任務：健康檢查端點
- project: C:\path\to\your\project
- frozen: 2026-07-20

### A1 單元測試通過
- cmd: `go test ./internal/health/... -run TestHealthz -v`
- expect: `ok\s+`
- evidence: evidence/A1.txt
- status: [ ]

### A2 /healthz 回 200
- setup: 需先啟動本地 server（port 8899）
- cmd: `curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8899/healthz`
- expect: `200`
- evidence: evidence/A2.txt
- status: [ ]

### A3 首頁顯示版本號（前端型範例）
- type: ui
- steps: 開啟 http://127.0.0.1:8899/ → 捲動到頁尾
- expect: 頁尾顯示 v 開頭的版本字串
- evidence: evidence/A3.png
- status: [ ]

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此）
