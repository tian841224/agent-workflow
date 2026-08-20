# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的共用規則；細節以 `.agents/skills/workflow/SKILL.md`、`risk-flags.md` 與 schema 為準，本檔只保留常駐護欄。

## 分流

- 只有修改「目標專案」application source code 或 test code logic 才進入 workflow、建立 task 並啟動角色。
- 設定、文件、註解、script、測試調查、除錯分析、code review、規劃、問答與翻譯都是 non-code：non-code tasks bypass workflow，不建立 task、不啟動角色（但若遇需求籠統或決策未明，主對話仍應適時調用 `planning` 與 `grill-me` 等思維技能輔助釐清）。
- `code_change: true` 必須填 `change_kind: fix | feature | refactor | chore`；`risk_flags` 只依實際風險填寫，允許值與額外 gate 以 schema／`risk-flags.md` 為準。
- Standard／Elevated 的流程差異、minimal／extended template 與角色觸發規則只維護在 workflow skill。

## Task 與角色

- Task 位於 `~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md`；每個 worktree 最多一個 `in_progress` task。
- `code_change: true` 依序執行 Reviewer → Verifier；命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 任一時，在兩者之間加入 Adversarial。
- Retrospective 只有疑似 regression、同一問題反覆修正或使用者要求時才啟動。
- 一般 task 由主對話依完成條件結案；coordinator／worker 或 Elevated legacy gate 使用 `~/.agent-workflow/runtime/agent_workflow.cmd close-task`。角色無法載入時先 Repair，仍失敗就 `blocked`；跳過角色必須由使用者授權並透過 `~/.agent-workflow/runtime/agent_workflow.cmd waive-roles --confirmed-by-user`。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- coordinator 不直接改主工作目錄 source，只能透過編排器的 `Apply` action；worker boundary 是協作式 guard，不是安全 sandbox。
- 先讀現況與規則，保留既有修改，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- Agent session 啟動時會由 managed `SessionStart` hook 自動載入 shared memory reference；原生來源只讀且可能過時，使用前仍須回查目前程式碼與設定。
- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論；新 task 由 managed memory hook 自動載入相關記憶。
- 使用臺灣慣用繁體中文回應；程式碼與技術術語保留原文。
- 對話開始時載入 `localization-tw` skill，中文輸出（回覆、文件、註解）依其臺灣用語規範檢查，避免中國用語殘留。
