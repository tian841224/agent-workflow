<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/plan.md -->

# <任務標題> — 實作藍圖

- project: <專案根目錄絕對路徑>
- track: 重軌
- created: <YYYY-MM-DD>

## 方案摘要

<architect 選定方案與理由；大改動附落選方案一句話對比>

## 要改的檔案與模組職責

- <path> — <職責/改動要點>

## 階段進度

- [ ] R1 需求凍結（PM：checklist.md frozen）
- [ ] R2 方案與藍圖（architect：本檔完成、使用者選定方案）
- [ ] R3 實作（architect：程式碼完成+作者自檢）
- [ ] R4 靜態把關（pre-review.ps1 通過 + reviewer 審查通過）
- [ ] R5 驗收與證據（qa 逐條收證據 + verify-evidence.ps1 全 PASS）
- [ ] R6 收尾沉澱（回報使用者、/learn 沉澱）

## 續作備註

<切批或中斷時：已完成內容、下一步輸入、地雷>
