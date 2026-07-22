<!-- 僅供程式任務使用；文件／規格／規劃本身由單一主 agent 處理，不建立 acceptance 文件。 -->
<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/checklist.md -->
<!-- 兩段式展開：PM 依 spec.md 商業規格寫 A<n> 條目（spec 溯源、test-type、given/when/then，不填 cmd/expect）；
     architect 技術規格完成後補 cmd/expect（前端條目補 type: ui + steps/expect），不得增刪改 PM 的條目。
     格式規約見 kit/acceptance-spec.md -->


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
- status: [ ]

## 修訂歷史

（凍結後經使用者核准的修訂記錄於此，一行一筆：日期 | 變更 | 核准依據）
