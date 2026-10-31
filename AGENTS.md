# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則。

## 分流

修改可能影響執行行為、資料、契約、安全性、部署、交付或 verification integrity 時，`managed_change: true`，載入 [.agents/skills/workflow/SKILL.md](.agents/skills/workflow/SKILL.md)。這是 managed workflow 的唯一 entry gate；`code_change` 只描述是否修改 application source code。

純文件、唯讀分析與不降低驗證能力的 test-only 修改直接處理。

## 硬護欄

- commit、push、rebase、merge 須先取得使用者明確授權。破壞性 Git 操作與隱藏 Git 執行（透過 wrapper、直譯器、remote/container、command substitution，或改變 Git 執行方式的設定）另須先說明實際操作、目標與影響；agent 不得自行授權或代填使用者確認，平台放行或 intent attestation 不代表使用者授權。
- 保留使用者既有修改與資料，只做需求直接需要的最小變更。
- 使用者指定的做法若明顯錯誤、矛盾、危險或造成不必要複雜度，先指出問題與影響並提出較安全、正確或更簡單的替代方案；合理取捨則尊重選擇繼續執行。
- 所有中文自然語言輸出一律使用臺灣慣用繁體中文，不使用簡體字或中國特有用語；技術詞彙沒有自然臺灣譯名時保留英文，保留程式碼與技術術語；中文敘述用全形標點，語氣自然直接；圖示能明顯提高理解時才用 ASCII。這條核心規則常駐；hook 會在每次提交訊息時注入 localization-tw skill 的用詞清單（例如「落地」不可用），核心規則同一個 session 只注入一次，輸出中文前先讀完再寫。<!-- skill:localization-tw -->

## Subagent

主對話自己完成讀取、規劃、實作與驗證。寫計畫的人就是執行計畫的人，才能依中途結果修正計畫；交接給 subagent 會遺失細節，也會拉長整體時間。

互不相依的讀取、搜尋與指令，由主對話在同一回合一起送出，平台會平行執行。開始開發任務，或開始需要讀取多個檔案、目錄的任務前，先評估能否平行，並用一句話告訴使用者結論，例如「同一回合平行讀 4 個檔案」「派 2 個 subagent 分別讀前端與後端」或「步驟相依，循序處理」。

只有下列情況才派 subagent：

- 兩件以上互不相依、各自要讀寫多個檔案才能完成的工作，例如依主題切分的大範圍讀取、寫入範圍不重疊的實作。這批在同一次呼叫平行派出。
- 讀取量大到會擠滿主對話，而主對話只需要結論與位置。
- 需要不受主對話推論影響的獨立判斷，例如 workflow 的 Reviewer。

subagent 是主對話的工具呼叫：主對話保有與使用者的對話、分類與 task lifecycle；brief 寫明目標、範圍與要回報的項目。回報中的結論在採用前，以實際檔案或指令核對。

派工時：

- 派工情況分為只讀不寫的派工、寫入範圍不重疊的平行實作、複審三種；各平台的派工規則只列出每種情況用哪個 agent 與模型。平台流程指定其他 agent 類型時，改用該類型，模型仍依對應的派工情況。複審雖然唯讀，但屬於獨立判斷，依複審那一列。
- 同一批 subagent 一次全部派出，再等待結果，不輪詢；各 worker 的寫入範圍不重疊，有先後相依的部分由主對話依序處理。
- 回報只帶結論與位置（路徑、行號或 symbol），不貼整段檔案內容。
- 以 subagent 身分收到指派時，直接完成指派範圍並回報，不再轉派。

## 進入 workflow 前的 pointers

- 修改 `.agents/` 底下 agent 或 skill 文件 → [writing-for-agents](.agents/skills/writing-for-agents/SKILL.md)；新增 skill 的 manifest 分類也依該 skill 處理。<!-- repo-only -->
- 使用 Plan mode 時 → 先載入 [implementation-spec](.agents/skills/implementation-spec/SKILL.md)，再依 skill 的適用範圍決定規格深度；短計畫不必擴寫成完整規格。
- 保存決策、更正或可重用結論時 → 一律依 [learn](.agents/skills/learn/SKILL.md) 分流寫入專案文件或 `~/.agent-workflow` 共用記憶，不寫平台原生記憶；三個平台才讀得到同一份。<!-- skill:learn -->
- 修改程式行為時 → 依 [project-docs](.agents/skills/project-docs/SKILL.md) 更新涵蓋改動路徑的 `docs/` 文件；專案還沒有任何文件時先建立。<!-- skill:project-docs -->
- 修改 agents、skills、hooks 或 workflow contract → 先讀 [docs/architecture.md](docs/architecture.md) 的「架構設計方向」與「Framework 變更政策」；改 hook 另讀「Hook trust boundary」。<!-- repo-only -->
- 使用者提及先前脈絡、prompt 太短、影響面中途改變或平台沒有 prompt hook → 依 [memory.md](.agents/skills/workflow/memory.md) 明確查詢記憶；其餘情況直接使用 hook 注入的記憶。
- 查看或分析前端頁面 → 優先讀 DOM，無法解析時才用截圖。
- 撰寫或修改 UI → Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- 撰寫 commit 訊息、規劃 commit 拆分或發起 PR／MR → 先讀 [git-commit](.agents/skills/git-commit/SKILL.md)。<!-- skill:git-commit -->

## 程式碼註解

註解補充程式碼無法清楚表達的原因、契約與限制。新增或修改契約、假設、單位／邊界、高風險判斷依據的註解，或整理大量註解時，先讀 [clean-comments](.agents/skills/clean-comments/SKILL.md)；以內容判斷，不以行數判斷。<!-- skill:clean-comments -->
