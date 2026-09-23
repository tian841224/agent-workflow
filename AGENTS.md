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
- 所有中文自然語言輸出一律使用臺灣慣用繁體中文，不使用簡體字或中國特有用語；技術詞彙沒有自然臺灣譯名時保留英文，保留程式碼與技術術語；中文敘述用全形標點，語氣自然直接；圖示能明顯提高理解時才用 ASCII。這條核心規則常駐，每個 session 開頭由 hook 注入具體的用語對照表（例如「落地」不可用），回覆前對照即可，不必另讀 skill。<!-- skill:localization-tw -->

## 進入 workflow 前的 pointers

- 修改 `.agents/` 底下 agent 或 skill 文件 → `writing-for-agents`；新增 skill 的 manifest 分類也依該 skill 處理。
- 修改 agents、skills、hooks 或 workflow contract → 先讀 [docs/architecture.md](docs/architecture.md) 的「架構設計方向」與「Framework 變更政策」；改 hook 另讀「Hook trust boundary」。
- 中文翻譯、長篇在地化或臺灣用語不確定 → `localization-tw`；一般中文回覆依上方硬護欄自我檢查。
- 使用者提及先前脈絡、prompt 太短、影響面中途改變或平台沒有 prompt hook → 依 [memory.md](.agents/skills/workflow/memory.md) 明確查詢記憶；其餘情況直接使用 hook 注入的記憶。
- 查看或分析前端頁面 → 優先讀 DOM，無法解析時才用截圖。
