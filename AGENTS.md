# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則。

## 分流

`managed_change` 是進入 managed workflow 的唯一 entry gate：這次修改可能影響系統實際行為、資料、契約、安全性、部署、執行結果、交付行為或 verification integrity 時為 `true`。`code_change` 只描述是否修改 application source code，不負責 workflow entry。

`managed_change: true` 時載入 `.agents/skills/workflow/SKILL.md` 並依它執行；分類判準、capability 選取、focused／expanded exploration 與 lifecycle 規則都以該 skill 與其指向的 schema 為準。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 先讀現況與規則，保留既有修改，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- 使用臺灣慣用繁體中文回應；程式碼與技術術語保留原文。
- 只有圖示能明顯提高理解時才用 ASCII 呈現概念。
- Agent 開始工作時會由 managed hook 自動載入 shared memory reference；原生來源只讀且可能過時，使用前回查目前程式碼與設定。
- 提煉出的 skill 草稿一律停留在 `skill-drafts/`，由使用者在對話中明確同意才執行 Promote。
- 新增專案 skill 時，先詢問使用者要列為必裝或選擇性，再更新 managed manifest。
- Implementation Worker 只執行 coordinator 提供的 ExecutionPacket，不自行重新分類任務或選 capability。

## Skill triggers

- 修改 application source code → `project-docs`：動手前 Lookup 並讀命中文件，改完後依結果建立或更新。<!-- skill:project-docs -->
- 修改 application source code logic → `clean-comments`。test code、文件、指令、設定、script、除錯與規劃不適用。
- 修改 `.agents/` 底下任何 agent 或 skill 文件 → `writing-for-agents`。
- 修改 `.agents/`、`src/`、`adapters/` 或 `schemas/` 中的 agents、skills、hooks 或 workflow contract → 先讀 `docs/architecture.md`。
- 安裝、同步、部署、migration、provisioning 或外部整合的完成宣稱 → `operational-verification`；證據不得跨越靜態設定、本機 mock、本機 runtime 與遠端環境等層級。<!-- skill:operational-verification -->
- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正 → `learn`，立即記錄可重用結論。
- Review 打回並修正後，開下一輪前記錄一次歸因；累積達門檻的補救（補文件、改任務規範、寫 skill）需使用者明確同意 → `distill`。
- 同一 session 首次需要 zh-TW 輸出 → `localization-tw`，之後同一 session 沿用已套用的規則檢查回覆即可。<!-- skill:localization-tw -->
- 查看或分析前端頁面 → 優先以 DOM 讀取工具解析與判斷，DOM 無法解析時才用截圖輔助。
