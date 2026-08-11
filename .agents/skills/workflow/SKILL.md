---
name: workflow
description: 實際修改 source code、可執行 script 或 test code 時使用。建立並維護統一 task.md，依序執行 Reviewer、Verifier；非程式碼修改任務不使用 workflow、不建立 task、不執行角色，由單一主對話處理。
---

# agent-workflow v4

## 1. 建立 Task

0. 本 skill 僅適用於實際修改 source code、可執行 script 或 test code 的任務；設定／文件修改、測試調查、除錯分析、code review、規劃、問答與翻譯等 non-code tasks bypass workflow，由單一主對話直接處理，不建立 task 或啟動角色。
1. 執行 `scripts/project-resolver.ps1 -Ensure` 取得 `project_id`、`worktree_id` 與 task 目錄。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作；不是就先將舊 task 改為 `paused`、`blocked`、`done` 或 `superseded`。
3. 依 `templates/task.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`。
4. 明確填寫 `code_change: true | false`：會修改 source code、可執行 script 或 test code 時為 `true`；只改設定／文件，或只執行測試、調查、code review 而未改 code 時為 `false`。
5. 基本任務直接使用 `status: in_progress`；命中 freeze-required flag 時先用 `draft`，經使用者確認後填 `frozen_at` 並改為 `in_progress`。

只有實際修改 source code、可執行 script 或 test code 才建立 task。非程式碼修改任務不載入本 workflow、不建立 task、不執行 Reviewer／Verifier。

## 2. 記憶

1. 建立／續作 task 後，以任務的 2–5 個關鍵字執行 `scripts/knowledge.ps1 -Action Search -Query '<keywords>' -Limit 5`，只讀 global 與目前 project 的最相關 entry；明顯不依賴歷史脈絡的機械性修改可略過。
2. `needs_verification` 或可能過時的記憶只能當線索，使用前回查目前程式、文件或設定。
3. 只有使用者糾正、可重用踩坑、重要方案決策、文件與實際行為不符或使用者明說要記住時，才以 `-Action Upsert -Scope Project` 寫入；沒有耐久價值時不增加任何步驟。
4. 同 topic 由 script 更新既有 native entry；相同內容自動去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `-ApprovedByUser`。
5. 有寫入時在 task 加 `Knowledge result` 記錄 entry id；沒有寫入時可完全省略。禁止寫入秘密、token、密碼、連線字串或個資。

## 3. Risk Flags

依實際風險判斷是否加入 `risk_flags`，不為湊流程加 flag。允許值、各值定義與對應要求見 [risk-flags.md](risk-flags.md)。

Reviewer／Verifier 與 risk flags 解耦：本 workflow 只接受 `code_change: true` 的程式碼修改任務，強制依序執行 Reviewer → Verifier。非程式碼修改任務不進入本 workflow（non-code tasks do not enter this workflow）；既有或匯入的 `code_change: false` task 僅作相容性資料，不啟動角色。

## 4. 實作

- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍。
- 修改程式後先建立 execution path：從實際入口往下追到修改點，再追到所有重要終點；同時確認修改點的上游前置條件、下游契約，以及錯誤、重送、並發與異步分支。不可只看修改點到下一個呼叫點。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- Bug 先重現或取得足以確認根因的證據；修改後執行相關驗證，無法自動化時在 task 記錄替代驗證與原因。
- 不強制 TDD 或 test-first；直接完成最小修改，再以專案既有檢查與 pre-review 驗證。
- 選最簡完整解法，沿用既有依賴與風格；不順手整理、抽象或擴張範圍。
- 發現新 hard-risk flag 時先更新 task；若需凍結則停手取得使用者確認。

## 5. Pre-review

程式碼或設定 diff 完成後，執行 managed runtime 的 `~/.agent-workflow/runtime/scripts/pre-review.ps1 -RepoRoot <root>`。Go 執行 changed-file gofmt、vet、build、test 與可用的 golangci-lint；Node 執行既有 lint、typecheck、build、test scripts；其他技術棧可用 `.pre-review-extra.ps1`。預設只保留 PASS／FAIL／SKIP 摘要，FAIL 的完整輸出寫入暫存 log。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。

## 6. Reviewer 與 Verifier

`code_change: true` 時，依序啟動原生 `agent-workflow-reviewer`、再啟動 `agent-workflow-verifier`；兩者唯讀，輸入只帶 task、diff、必要專案規則與驗證證據。`code_change: false` 跳過兩個角色。

- Reviewer 先核對 correctness，再回報 architecture consistency、code quality and conventions、data consistency、security、risk and compatibility、performance；data consistency、security、performance 不適用時標 `N/A` 與理由。
- Reviewer 必須沿 execution path 審查：確認入口如何到達修改點、上游傳入的前置條件與狀態、修改點的行為、下游每一段的輸入／輸出契約與最終效果。以 `A > B > C > D` 為例，修改 `C` 時必須審查並驗證 `A > B > C > D`，不能只審查 `C > D`；重要錯誤、重送、並發、異步與替代分支也要納入回歸範圍，並在 task 留下 path 與證據。
- Reviewer 有 blocker：主 agent 修正，重新執行相關驗證，再送複審。
- Reviewer 通過後，Verifier 從實際入口執行完整 path，逐條執行完成條件，補一次最可能找到 bug 的針對性探索；不得以只測修改函式或只測 `C > D` 代替整體流程；`ui` 使用 browser。
- Verifier 將問題分為實作缺陷、規格缺漏、環境阻塞；實作缺陷批次修正後重驗失敗與波及項。
- 原生角色載入失敗時先執行 installer `Repair`；仍失敗才由主 agent 明確切換唯讀身分代跑，task 與回報標記 `independence: degraded`。

## 7. 失敗與續作

- 同一修復假說失敗兩次，不再猜第三次；回到證據與根因重新診斷。
- Reviewer／Verifier 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `paused`；缺權限、環境或外部決策用 `blocked` 並記錄下一步。
- 不維護額外 state service；task.md 是唯一任務狀態。

## 8. 完成

1. 對照 task 完成條件，填入 pre-review、其他實際指令、結果與未驗證限制。
2. 回填 Reviewer／Verifier 結果與 `independence` 狀態（若適用）。
3. 所有必要條件通過才將 status 改為 `done`；未完成不得假裝結案。
4. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。
