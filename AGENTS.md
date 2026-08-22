# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則；細節以 `.agents/skills/workflow/SKILL.md`、`risk-flags.md` 與 schema 為準

## 分流

實際修改「目標專案」application source code logic、且達到 workflow 觸發條件時才建立 task、載入 workflow skill；純 test code 修改仍執行相關測試但 bypass workflow；設定、文件、註解、script、除錯、review、規劃、問答與翻譯等非程式碼任務一律 bypass，不建立 task、不啟動角色。判斷細節與 Standard／Elevated 分流見 workflow skill。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 先讀現況與規則，保留既有修改，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- Agent session 啟動時會由 managed `SessionStart` hook 自動載入 shared memory reference；原生來源只讀且可能過時，使用前仍須回查目前程式碼與設定。
- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論。
- 使用臺灣慣用繁體中文回應；程式碼與技術術語保留原文。
- 對話開始時載入 `localization-tw` skill，中文輸出（回覆、文件、註解）依其臺灣用語規範檢查，避免中國用語殘留。
- 修改 `.agents/` 下任何 agent 或 skill 文件時載入 `writing-for-agents` skill。
