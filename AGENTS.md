# agent-workflow

跨 Claude Code、Codex、Antigravity 的共用規則；細節以 `.agents/skills/workflow/SKILL.md`、`risk-flags.md` 與 schema 為準

## 分流

是否進入 workflow 只由 `managed_change` 決定，不是 `code_change`。

`managed_change: true` 表示這次修改可能影響系統實際行為、資料、契約、安全性、部署、執行結果、交付行為或 verification integrity。這包含 application source code 以外的 CI/CD、Dockerfile、nginx、SQL migration、deploy script、Terraform 等變更。

純文件、註解、read-only 分析、review、規劃、問答與翻譯通常為 `managed_change: false`。

Config、script 或其他 non-application-source change 依實際影響判斷。

Test-only 新增測試、強化 assertion 或不降低驗證能力的 refactor 可使用 `managed_change: false`。只有刪除／skip 測試、弱化 assertion 或大量重寫 snapshot／fixture baseline 時使用 `managed_change: true` 並加入 `test_integrity` risk flag。

`code_change` 只描述是否修改 application source code，不負責 workflow entry。詳細分類、Standard／Elevated 與 capability 選取規則以 workflow skill 為準。

單純讀取、檢查或解釋任務可使用 `task_type: read_only`；`model_profile`（`cheap_read`／`deep_read`）由 runtime 依 `impact_scope`／`impact_effect`／`risk_flags` 推導，不由 agent 自由選擇。Codex／Claude 應選用已安裝的 read-only reader agent，不啟動 implementation worker。Implementation Worker 只執行 coordinator 提供的 ExecutionPacket，不自行重新分類任務或選 capability。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 先讀現況與規則，保留既有修改，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- 安裝、同步、部署、migration、provisioning 或外部整合的完成宣稱，先載入 `operational-verification` skill；證據不得跨越靜態設定、本機 mock、本機 runtime 與遠端環境等層級。<!-- skill:operational-verification -->
- Agent session 啟動時會由 managed `SessionStart` hook 自動載入 shared memory reference；原生來源只讀且可能過時，使用前仍須回查目前程式碼與設定。
- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論。
- Review 打回並修正後，開下一輪前記錄一次歸因；累積達門檻的補救（補文件、改任務規範、寫 skill）一律需使用者明確同意。
- 提煉出的 skill 草稿一律停留在 `skill-drafts/`，只有使用者在對話中明確同意才執行 Promote；agent 不得自行核准。
- 使用臺灣慣用繁體中文回應；程式碼與技術術語保留原文。
- Use ASCII to visualize content when explaining concepts.
- 每一次自然語言輸出前，一律載入並套用 `localization-tw` skill；不得自行判斷本次內容簡單而略過。輸出前必須依 `localization-tw` 檢查完整回覆，修正中國慣用詞、簡體用語、臺灣不常用表達、標點與語氣後才可輸出。遇到不確定詞彙時，再查閱該 skill 的 references，不需每次重讀整份 skill。<!-- skill:localization-tw -->
- 修改 application source code 前，依 `project-docs` skill 查出涵蓋本次路徑的文件並讀過再動手；改完後依查詢結果建立缺少的文件或更新已失準的內容。<!-- skill:project-docs -->
- 修改 application source code logic 前，一律載入 `clean-comments` skill；test code、文件、指令、設定、script、除錯、規劃及其他非程式邏輯工作不適用。
- 修改 `.agents/` 下任何 agent 或 skill 文件時載入 `writing-for-agents` skill。
- 修改 `.agents/`、`src/`、`adapters/` 或 `schemas/` 中的 agents、skills、hooks 或 workflow contract 前，先讀 `docs/architecture.md`。
- 查看或分析前端頁面時優先以 DOM（如 read_page、get_page_text）解析與判斷；只有在 DOM 無法解析或依 DOM 判斷有誤時，才考慮改用畫面截圖（screenshot）輔助。
- 新增專案 skill 時，先詢問使用者要列為必裝或選擇性，再更新 managed manifest；未獲確認前不得自行分類。
