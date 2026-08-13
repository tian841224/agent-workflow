# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式工作規則。平台只提供原生入口與角色格式；流程與品質標準共用。

## 適用範圍

只有實際修改 source code 邏輯、可執行 script 或 test code 的任務，才載入 `workflow` skill、建立 `task.md`，並依序執行 Reviewer、Verifier。純註解修改、設定／文件修改、測試調查、除錯分析、code review、規劃、問答與翻譯等沒有動到程式邏輯的修改與任務，不載入 workflow、不建立 task、不執行角色，由單一主對話直接處理（non-code tasks bypass workflow）。

## Task

- Task 位於 `~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md`。
- 每個 worktree 最多一個 `status: in_progress`；不同 worktree 可平行。
- Task 必須明確填 `code_change: true | false`；只有實際修改 source、script 或 test code 時為 `true`，並同時填 `change_kind: fix | feature | refactor | chore`。
- 基本 task 只記目標、範圍、完成條件與驗證結果；其他內容與 gate 依 `risk_flags` 增加。
- 完成後經 `close-task.ps1` 改為 `done`；中斷改 `paused`；缺外部條件改 `blocked`；需求變更以新 task 取代並將舊 task 標 `superseded`。

## 品質原則

- 先讀現況與專案規則，保留使用者既有修改，只改需求直接需要的內容。
- Bug 先重現或取得根因證據；遵循 TDD，先寫會失敗的測試再實作使其通過、視需要重構，修改後執行相關驗證與 `~/.agent-workflow/runtime/scripts/pre-review.ps1`。
- 選完整滿足目前需求的最簡解法；不順手重構、不增加未要求的抽象或依賴。
- 只有 `code_change: true` 強制依序執行 Reviewer、Verifier；`risk_flags` 命中 financial／data_write／migration／irreversible／schema／contract 任一時，Reviewer 與 Verifier 之間加開 Adversarial 複查；`change_kind: fix` 時收尾前加開 Retrospective，判定是否為先前修改造成的回歸並歸因到漏接的 gate。非程式碼修改不執行角色。Risk flags 仍控制 browser、安全、資料一致性與凍結 gate。
- 驗證失敗先修根因，再重跑失敗項與受波及回歸項；不改完成條件遷就實作。

## 記憶

- 工作依賴歷史決策或專案脈絡時，以 `scripts/knowledge.ps1 -Action Search` 讀取 global 與 project knowledge；只載入最相關結果，`needs_verification` 不當成已確認事實；專案結構與模組流程改讀 `project-doc.ps1 -Action Lookup -Paths`。
- 只在使用者糾正、可重用踩坑、重要決策或既有認知失效時 Upsert project knowledge；沒有耐久價值就不寫。Global 寫入須有跨專案證據並取得使用者同意。
- 記憶不得包含秘密、token、密碼、連線字串或個資；同 topic 優先更新與關聯，不建立重複 entry。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 原生 Reviewer／Adversarial／Verifier 無法載入或未回報時先 Repair；仍失敗則將 task 改為 `blocked`，不得由主 agent 代跑後結案；跳過角色須由使用者授權並填 `roles_waived`。
- `status: done` 只能由 `~/.agent-workflow/runtime/scripts/close-task.ps1` 寫入，它會先重跑完整完成 gate。
- 使用台灣慣用語繁體中文回應；程式碼與技術術語保留原文。
- coordinator 不得直接改主工作目錄 source，僅能經 `orchestrate.ps1 -Action Apply`；worker boundary 為協作式 guard，非安全 sandbox，見 [orchestration.md](.agents/skills/workflow/orchestration.md)。
