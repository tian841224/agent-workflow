# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式工作規則。平台只提供原生入口與角色格式；流程與品質標準共用。

## 適用範圍

只有實際修改 source code 邏輯或 test code 的任務，才載入 `workflow` skill、建立 `task.md`，並依序執行 Reviewer、Verifier。純註解修改、設定／文件修改、script 修改與操作、測試調查、除錯分析、code review、規劃、問答與翻譯等沒有動到程式邏輯的修改與任務，不載入 workflow、不建立 task、不執行角色，由單一主對話直接處理（non-code tasks bypass workflow）。

## Task

- Task 位於 `~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md`。
- 每個 worktree 最多一個 `status: in_progress`；不同 worktree 可平行。
- Task 必須明確填 `code_change: true | false`；只有實際修改 source code logic 或 test code logic 時為 `true`，並同時填 `change_kind: fix | feature | refactor | chore`。script 修改與操作不進入 workflow。
- 基本 task 只記目標、範圍、完成條件與驗證結果；其他內容與 gate 依 `risk_flags` 增加。
- 一般 task 在 Reviewer／Verifier 完成後即可更新為 `done`；coordinator／worker 或命中 freeze-required flag 的 task 才使用 `close-task.ps1` 完整結案。中斷改 `paused`，缺外部條件改 `blocked`，兩者都必須填 `stop_reason`；需求變更以新 task 取代並將舊 task 標 `superseded`。
- 命中 freeze-required flag 時 `frozen_at` 未填前不得改 code；這是高風險流程規則，`impact-guard` 只在對應 profile 啟用時執行機械攔截。

## 品質原則

- 先讀現況與專案規則，保留使用者既有修改，只改需求直接需要的內容。
- Bug 先重現或取得根因證據；遵循 TDD，先寫會失敗的測試再實作使其通過、視需要重構，修改後執行相關驗證與 `~/.agent-workflow/runtime/scripts/pre-review.ps1`。
- 選完整滿足目前需求的最簡解法；不順手重構、不增加未要求的抽象或依賴。
- 只有 `code_change: true` 強制依序執行 Reviewer、Verifier；`risk_flags` 命中 financial／data_write／migration／irreversible／schema／contract 任一時，Reviewer 與 Verifier 之間加開 Adversarial 複查。Retrospective 只在疑似 regression、同一問題反覆修正或使用者要求時啟動。非程式碼修改不執行角色。Risk flags 仍控制 browser、安全、資料一致性與凍結 gate。
- 驗證失敗先修根因，再重跑失敗項與受波及回歸項；不改完成條件遷就實作。

## 記憶

- 工作依賴歷史決策或專案脈絡時，以 `scripts/knowledge.ps1 -Action Search` 讀取 global 與 project knowledge；只載入最相關結果，`needs_verification` 不當成已確認事實；專案結構與模組流程改讀 `project-doc.ps1 -Action Lookup -Paths`。
- 只在使用者糾正、可重用踩坑、重要決策或既有認知失效時 Upsert project knowledge；沒有耐久價值就不寫。Global 寫入須有跨專案證據並取得使用者同意。
- 記憶不得包含秘密、token、密碼、連線字串或個資；同 topic 優先更新與關聯，不建立重複 entry。

## 硬護欄

- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 不覆寫、刪除或重設使用者未要求處理的修改與資料。
- 原生 Reviewer／Adversarial／Verifier 無法載入或未回報時先 Repair；仍失敗則將 task 改為 `blocked`，不得由主 agent 代跑後結案；跳過角色須由使用者授權，並以 `waive-roles.ps1 -ConfirmedByUser` 寫入 `roles_waived`，不得直接編輯 task。
- 高風險與 coordinator／worker task 的 `status: done` 只能由 `~/.agent-workflow/runtime/scripts/close-task.ps1` 寫入；一般 task 由主對話依完成條件更新狀態。
- 使用台灣慣用語繁體中文回應；程式碼與技術術語保留原文。
- coordinator 不得直接改主工作目錄 source，僅能經 `orchestrate.ps1 -Action Apply`；worker boundary 為協作式 guard，非安全 sandbox，見 `~/.agent-workflow/runtime/skills/workflow/orchestration.md`。
- 能用原生指令完成時（git、CLI 工具的批次選取／覆蓋等）不自製程式繞過或重做；原生指令被安全機制擋下時，優先找原生工具的唯讀／迂迴用法，而非自行重新實作同一件事的邏輯。
