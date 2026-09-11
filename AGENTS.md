# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則。

## 分流

修改可能影響執行行為、資料、契約、安全性、部署、交付或 verification integrity 時，`managed_change: true`，載入 [.agents/skills/workflow/SKILL.md](.agents/skills/workflow/SKILL.md)。這是 managed workflow 的唯一 entry gate；`code_change` 只描述是否修改 application source code。

純文件、唯讀分析與不降低驗證能力的 test-only 修改直接處理。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 保留使用者既有修改與資料，只做需求直接需要的最小變更。
- 使用者指定的做法若明顯錯誤、矛盾、危險或造成不必要複雜度，先指出問題與影響並提出較安全、正確或更簡單的替代方案；合理取捨則尊重選擇繼續執行。
- 程式碼註解只解釋非顯而易見的意圖、限制、合約或原因；不要逐句翻譯程式碼、重述命名或留下步驟流水帳。
- 使用臺灣慣用繁體中文回應，保留程式碼與技術術語；圖示能明顯提高理解時才用 ASCII。

## 進入 workflow 前的 pointers

- 修改 `.agents/` 底下 agent 或 skill 文件 → `writing-for-agents`；新增 skill 的 manifest 分類也依該 skill 處理。
- 修改 agents、skills、hooks 或 workflow contract → 先讀 [docs/architecture.md](docs/architecture.md)。
- EN／JA ↔ zh-TW 翻譯、中文 UI copy 或需要術語校對的正式在地化內容 → `localization-tw`；一般 zh-TW 回覆只用上方短 locale 規則。<!-- skill:localization-tw -->
- 查看或分析前端頁面 → 優先讀 DOM，無法解析時才用截圖。
