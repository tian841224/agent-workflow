<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/checklist.md -->
<!-- 由 PM 依同目錄凍結的 spec.md 展開；每條必須溯源 spec: S<n>，格式規約見 kit/acceptance-spec.md -->

# <任務標題>
- project: <專案根目錄絕對路徑>
- frozen: draft

### A1 <行為描述>
- spec: S1
- test-type: <規格逐條 / 邊界值 / 等價類 / 異常路徑 / 情境 / 非功能>
- given: <前提條件>
- when: <執行動作>
- then: <預期結果>
- cmd: `<單行可執行指令>`
- expect: `<regex>`
- evidence: evidence/A1.txt
- status: [ ]

### A2 <前端行為描述（僅前端修改時使用此型）>
- spec: S2
- test-type: <規格逐條 / 邊界值 / 等價類 / 異常路徑 / 情境 / 非功能>
- given: <前提條件>
- when: <執行動作>
- then: <預期結果>
- type: ui
- steps: <browser 操作描述>
- expect: <畫面預期>
- evidence: evidence/A2.png
- status: [ ]

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此，一行一筆：日期 | 變更 | 核准依據）
