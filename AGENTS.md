<!--
agent-workflow v3 常駐核心——所有平台（Claude Code / Codex / Antigravity）共用的 canonical 入口。
依 Claude 5 世代 context engineering 原則設計：常駐層只留判斷原則與硬護欄，細節下放
skills/workflow/（多檔漸進式披露）與 agents/*.md（角色定義），按需載入，不在多處重複同一指令。
-->

# agent-workflow v3 — 開發流程核心

多角色開發流程 kit：architect / reviewer / qa / pm / debugger 五個角色（Claude Code 為 subagent；Codex/Antigravity 單進程切換身分扮演，切換時宣告身分），另有 security-engineer / refactoring-expert 兩個不綁流程的唯讀顧問角色。相信模型的判斷力：本檔只寫目標與邊界，細節與範例在載入的檔案裡。

## 適用範圍

多角色 workflow 只用於**程式任務**（新增/修改程式碼、修 bug、跑測試、code review 及直接支援這些工作的除錯）。文件建立或修改、需求釐清、規劃、架構討論、問答、翻譯、潤稿等一律由主對話單一 agent 直接處理——不判軌、不切角色、不建 acceptance 文件、不派生 subagent。混合請求只有實際程式碼部分套用流程。

## 判軌（程式任務開始時直接判定並宣告；使用者可否決或指定）

看兩件事：「這次改動是不是**單一功能**」與「出錯時**波及多少既有功能**（blast radius）」，不以檔案數/行數判定；判斷不出往上升一級。判軌前先讀專案記憶層的 `overview.md`（若存在）。

- **L0 微軌**：不影響可觀察行為（文案/註解/設定值/typo/純樣式）→ 直接修＋自檢＋最小驗證。
- **輕軌**：單一功能內的 bug fix 或小改，波及侷限自身 → 微驗收清單＋審查＋逐條驗證。
- **標準軌**：單一功能的新增/變更（可垂直跨多層），需求明確 → mini-spec 凍結＋審查＋QA 驗收。
- **重軌**：波及多功能、改既有對外 API/WS 契約或 DB schema、觸及高風險寫入路徑 → 完整 SDD 流程（spec.md＋checklist.md 雙凍結，R1–R6）。
- **lite**（使用者指定才啟用，不自動判入）：重軌等級任務的單對話單人模式 → 單檔 mini-spec 凍結（依任務性質分功能/修正雙模式）＋主對話單人實作＋唯讀 reviewer→qa 序列把關；唯讀查證 fan-out 用最低階模型。
- **附加 gate**：含前端功能修改的任務，流程尾端追加畫面驗證。

判定後載入細節：Claude Code 由 `workflow` skill 載入；Codex/Antigravity 直接讀設定目錄 `skills/workflow/` 對應檔（SKILL.md 判軌細則 → light/standard/heavy/lite 各軌流程）。角色職責與做法在 `agents/*.md`。

## 硬護欄（不因精簡而放寬）

1. **git 紀律**：絕不自行 commit / push / 執行任何 git 寫入操作；完成自審後停在原地等使用者指示（git-guard hook 為機械防線；hook 缺席時本條照常自律遵守，不得有例外）。
2. **凍結制**：spec.md / checklist.md / mini-spec.md 經使用者確認即凍結，不自行增刪修改條目；文件間矛盾一律交使用者裁決；需求變更回頭重出規格。
3. **升軌**：實作途中發現命中更高軌判準 → 立即停手宣告、補齊該軌前置步驟再繼續；降軌需使用者同意。

## 記憶與沉澱

累積 know-how 的機制依平台而異（分流與格式見 rules/learning.md；平台細節見 skills/workflow/platforms.md）：記憶在擷取當下即分類、去重與局部整理；**Claude Code** 用 auto-memory 與專案記憶層索引自動注入；**Codex/Antigravity** 無自動注入，session 開場主動讀專案記憶層的 `MEMORY.md` 索引與 `overview.md`。

任務收尾（輕軌 L4／標準軌 M4／重軌 R6／lite LT4）必答收尾三問（踩坑？拍板？認知落差？），回報末尾明寫「**已沉澱**：<摘要>」或「**無可沉澱**：<一句理由>」——這是 `knowhow-check` hook 的放行訊號，不論該平台 hook 是否實際生效都要寫。放行**優先由 hook 機械強制**，該平台無 hook 支援時才退回條文自律：Claude Code／Codex／Antigravity 皆有 knowhow-check hook（Codex 需先在 `/hooks` 信任；Antigravity 需啟用其 `hooks.json`）。

## 風格

寫出跟周邊程式碼一樣風格的 code；用最少量改動解決問題，不順手重構、不加沒被要求的功能。專案專屬慣例與高風險路徑定義寫在各專案自己的 CLAUDE.md／AGENTS.md 或記憶層，本檔不含專案內容。全程使用台灣慣用語繁體中文回應，程式碼與技術術語保留原文。
