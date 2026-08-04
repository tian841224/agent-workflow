<!-- 僅供程式任務使用；一般規格由單一主 agent 處理，不建立 acceptance 文件。 -->
<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/mini-spec.md
     標準軌（M 軌）／lite 軌共用：單檔規格，不分商業/技術兩段、不另建 checklist.md/plan.md。
     標準軌由 architect、lite 由主對話一次寫完，使用者一次確認即凍結。格式規約見 workflow/acceptance-spec.md -->

# <任務標題> — 規格（mini-spec.md）
- project: <專案根目錄絕對路徑>
- frozen: draft

## 目標

<要解決什麼>

## 範圍 / 非目標

- 範圍: <要動什麼，侷限單一功能（實作可垂直跨多模組/分層）>
- 非目標: <明確不做什麼，防 scope creep>

## 設計分析（lite 軌選填；標準軌不用）

<功能模式：商業規格要點（條目化規格與輸入/輸出/邊界錯誤定義）；修正模式：選定做法與理由、六大面向自審結論摘要。中斷續作只讀本檔，分析結論靠本段回復脈絡>

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
