<!-- 僅供程式任務使用；一般規格由單一主 agent 處理，不建立 acceptance 文件。 -->
<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/mini-spec.md
     標準軌（M 軌）專用：單檔規格，不分商業/技術兩段、不另建 checklist.md/plan.md。
     由 architect 一次寫完，使用者一次確認即凍結。格式規約見 workflow/acceptance-spec.md -->

# <任務標題> — 標準軌規格（mini-spec.md）
- project: <專案根目錄絕對路徑>
- frozen: draft

## 目標

<要解決什麼>

## 範圍 / 非目標

- 範圍: <要動什麼，侷限單一模組>
- 非目標: <明確不做什麼，防 scope creep>

## TDD seam

<可被自動化測試覆蓋的邏輯與切入點；供實作階段紅綠迴圈直接引用>

## 驗收條目

### A1 <行為描述>
- test-type: <規格逐條 / 邊界值 / 等價類 / 異常路徑 / 情境 / 非功能>
- given: <前提條件>
- when: <執行動作>
- then: <預期結果>
- cmd: `<單行可執行指令>`
- expect: `<regex>`
- status: [ ]

### A2 <前端行為描述（僅前端修改時使用此型）>
- test-type: <規格逐條 / 邊界值 / 等價類 / 異常路徑 / 情境 / 非功能>
- given: <前提條件>
- when: <執行動作>
- then: <預期結果>
- type: ui
- steps: <browser 操作描述>
- expect: <畫面預期>
- status: [ ]

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此，一行一筆：日期 | 變更 | 核准依據）
