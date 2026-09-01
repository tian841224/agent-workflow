# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則；細節以 `.agents/skills/workflow/SKILL.md`、`risk-flags.md` 與 schema 為準

## 分流

實際修改「目標專案」application source code logic、且達到 workflow 觸發條件時才建立 task、載入 workflow skill；純 test code 修改仍執行相關測試但 bypass workflow；設定、文件、註解、script、除錯、review、規劃、問答與翻譯等非程式碼任務一律 bypass，不建立 task、不啟動角色。判斷細節與 Standard／Elevated 分流見 workflow skill。

單純讀取、檢查或解釋任務可使用 `task_type: read_only` 與 `model_profile: cheap_read`；Codex／Claude 應選用已安裝的 read-only reader agent，不啟動 implementation worker。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 先讀現況與規則，保留既有修改，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- 安裝、同步、部署、migration、provisioning 或外部整合的完成宣稱，先載入 `operational-verification` skill；證據不得跨越靜態設定、本機 mock、本機 runtime 與遠端環境等層級。
- Agent session 啟動時會由 managed `SessionStart` hook 自動載入 shared memory reference；原生來源只讀且可能過時，使用前仍須回查目前程式碼與設定。
- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論。
- Review 打回並修正後，開下一輪前記錄一次歸因；累積達門檻的補救（補文件、改任務規範、寫 skill）一律需使用者明確同意。
- 提煉出的 skill 草稿一律停留在 `skill-drafts/`，只有使用者在對話中明確同意才執行 Promote；agent 不得自行核准。
- 使用臺灣慣用繁體中文回應；程式碼與技術術語保留原文。
- Use ASCII to visualize content when explaining concepts.
- 中文回覆、文件或註解開始前載入 `localization-tw` skill；每次輸出前依已載入的 skill 檢查完整內容，再修正臺灣用語、語氣、標點與中國用語，只有完成檢查後才輸出。遇到不確定詞彙時，再查閱該 skill 的 references，不需每次重讀整份 skill。
- 修改 application source code 前，依 `project-docs` skill 查出涵蓋本次路徑的文件並讀過再動手；改完後依查詢結果建立缺少的文件或更新已失準的內容。
- 修改 application source code logic 前，一律載入 `clean-comments` skill；test code、文件、指令、設定、script、除錯、規劃及其他非程式邏輯工作不適用。
- 修改 `.agents/` 下任何 agent 或 skill 文件時載入 `writing-for-agents` skill。
- 修改 `.agents/`、`src/`、`adapters/` 或 `schemas/` 中的 agents、skills、hooks 或 workflow contract 前，先讀 `docs/architecture.md`。
- 查看或分析前端頁面時優先以 DOM（如 read_page、get_page_text）解析與判斷；只有在 DOM 無法解析或依 DOM 判斷有誤時，才考慮改用畫面截圖（screenshot）輔助。
- 新增專案 skill 時，先詢問使用者要列為必裝或選擇性，再更新 managed manifest；未獲確認前不得自行分類。
