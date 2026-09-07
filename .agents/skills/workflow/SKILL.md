---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow，再由主對話依實際 impact 與 risk 選擇 capability。純文件、唯讀分析與不降低驗證能力的 test-only 修改 bypass；可能影響執行、資料、契約、安全性、部署、交付或 test integrity 的修改進入 workflow。
---

# agent-workflow

Managed change 的執行主流程。每一節只說要做什麼、去哪裡讀；規則的 authority 在指向的 schema、policy 或 reference 文件。

修改本 framework 的 agents、skills、hooks 或 workflow contract 前，先讀 [architecture.md](../../../docs/architecture.md)：task.md／task.json 的分工、`task.json` 的寫入限制與 lifecycle 語意都由它擁有。`task.json` 一律經 runtime CLI 寫入，直接檔案寫入由 hook fail-closed 攔截。

```text
1. 判斷 managed_change     false 直接 bypass，不建立 task
2. 建立或更新 task
3. workflow-plan          取得 required／suggested／requested／selected／order
4. 依 selected 載入必要 skill
5. 實作
6. 驗證與 pre-review
7. 記錄 evidence
8. reviewer（只有被 selected 才執行）
9. task-gate 與 close-task
```

## 1. 判斷 managed_change

`managed_change` 是進入 workflow 的唯一 gate。`code_change` 只描述是否修改目標專案的 application source code。

`managed_change: true`：修改 application source code 並可能改變行為；修改資料、schema、migration 或持久化行為；修改公開契約、授權、安全性或跨功能行為；修改 CI/CD、Dockerfile、nginx、Terraform、deploy script 或其他可能改變部署與執行結果的設定；修改測試時降低或重新定義既有驗證可信度。

`managed_change: false`：純文件或註解；純 read-only 分析、review、規劃、問答或翻譯；只新增測試；只強化既有 assertion；不降低驗證能力的 test refactor、fixture 維護或測試結構整理。

Config、script 或其他 non-application-source change 依是否可能改變部署、執行、資料或交付結果判斷，不以「不是程式碼」作為 unmanaged 的依據。

Test-only change 只有在刪除既有測試、skip／disable 既有測試、弱化 assertion，或大量重寫 snapshot／fixture 使既有 regression baseline 被重新定義時才進 workflow，此時使用 `code_change: false`、`managed_change: true`、`task_type: chore`、`risk_flags: ["test_integrity"]`，並依實際情況宣告 `workflow_facts` 的 `test_deleted`／`test_skipped`／`assertion_weakened`／`snapshot_mass_change`。

一般唯讀問答、分析與 review 直接 bypass，不建立 task，由 host 選用唯讀 reader agent。`task_type: read_only` 只用於本來就存在 task record 的唯讀或 orchestration 情境；`model_profile` 由 runtime 依分類推導，不由 agent 指定。

原先判定 unmanaged，處理中發現會改變 runtime behavior、delivery behavior 或 verification integrity 時，用 `task-write` 把同一 task 的 `managed_change` 改為 `true`；同時涉及 application source code 就一併把 `code_change` 改為 `true`（runtime 會執行 worktree lease、dirty check 與 `base_commit` 綁定）。`code_change` 只能由 `false` 改為 `true`。整個 task 分類錯誤、需要放棄目前 delivery 時，`supersede` 後另建新 task。

`managed_change: false` 的 task 不啟動任何 capability 或角色，也不因本 skill 建立 task 或執行 pre-review。

## 2. 建立或更新 task

1. Standard task 直接沿用已知的 task context；只有需要跨 worktree 或 coordinator／worker 時才執行 `agent-workflow project-resolver -Ensure`。
2. 同一 worktree 已有 `in_progress` task 時確認是否為續作，需要時用 `resume` 接回。`paused` 與 `blocked` 仍佔用該 worktree 的 code task lease：放棄舊 task 用 `supersede`，要完成舊 task 則先 `resume` 再 `close-task`，否則改用不同 worktree。
3. 預期會修改架構、契約或跨模組行為時，先讀 [elevated.md](elevated.md) 的建立前規則。
4. Standard task 依 `templates/task-minimal.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`；Elevated 或 coordinator／worker task 依 `templates/task.md`。同一目錄執行 `agent-workflow task-init --task-path <dir>`（stdin 傳初始欄位的 JSON，`id` 取目錄名）建立 `task.json`。
5. 建立時一次填入已知分類，使用 `workflow_mode: main` 與主對話選定的 `workflow_request`。`task_type` 是唯一的變更分類欄位，`code_change: true` 結案時必填。
6. 依實際風險填 `risk_flags`。允許值、定義、freeze-required 規則與 `unclear_requirements` 的釐清流程見 [risk-flags.md](risk-flags.md)。命中 freeze-required flag 時 `intent_approval` 先留空，取得使用者對目標、非目標與完成條件的確認後才執行 `approve-intent --confirmed-by <who> --as-user`。

## 3. workflow-plan

執行 `agent-workflow workflow-plan --task-path <path>` 取得 `required`、`classification_incomplete`、`suggested`、`requested`、`selected` 與 `order`，以它為準，不靠文件手算會選到哪些 capability。

十六個 capability：`baseline_validation`、`impact_discovery`、`codebase_design`、`bug_diagnosis`、`tdd`、`schema_compatibility`、`migration_safety`、`data_impact`、`contract_review`、`execution_path_review`、`regression_validation`、`test_integrity`、`mutation_validation`、`security_review`、`operational_verification`（`kind: evidence`，產出寫在各自 section 的 `- <step id>:` 行）與 `reviewer`（`kind: role`，獨立唯讀複審，見 §8）。

`required` 是 runtime 依分類算出的下限，`workflow_request` 只能疊加，移除只能明確 `waive`。`impact_confidence` 不在受保護之列，調低它只會讓 gate 要求更多，屬於 agent 自己的分析狀態，可直接用 `task-write` 更新。`required` 為空時任何組合都合法，包含一個 capability 都不跑（此時 `## Impact surface` 必填，說明判斷依據）。`classification_incomplete` 與 `step_classification_incomplete` 會擋下 gate，必須補齊被點名的分類欄位。選取規則見 [capability-selection.md](capability-selection.md)；capability 與 step 的觸發條件以 `schemas/workflow-policy.json` 的 `require_when` 與 `when` 為權威來源。

## 4. 依 selected 載入必要 skill

只載入被選中的：

- `codebase_design` → [codebase-design skill](../codebase-design/SKILL.md)
- `bug_diagnosis` → [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md)
- `tdd` → [TDD skill](../tdd/SKILL.md)
- `operational_verification` → [operational-verification skill](../operational-verification/SKILL.md)

前置決策 skill 不建立獨立 task section：架構設計、feature planning、refactor 策略或 `unclear_requirements` 先載入 [planning skill](../planning/SKILL.md)；使用者已選定的方案涉及新增 abstraction、interface、adapter、wrapper、cross-layer seam 或可疑複雜度時，先載入 [push-back skill](../push-back/SKILL.md) 檢查最小方案；高風險且不可逆的未決取捨再加開 [grill-me skill](../grill-me/SKILL.md)。

## 5. 實作

Elevated task 另有建立前與實作前規則見 [elevated.md](elevated.md)；以下適用所有 task。

- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍。發現架構或影響面不明時升級為 Elevated task。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- 修改 application source code 前執行 `agent-workflow project-doc --action Lookup --paths '<本次要動的路徑>'` 並讀命中的文件；修改 application source code logic 前載入 [clean-comments skill](../clean-comments/SKILL.md)。test code 與其他 non-code task 不適用。
- 任務依賴歷史脈絡、使用者要求或已知回歸時才查記憶；查詢與寫入規則見 [memory.md](memory.md)。
- 發現新的高風險 flag 時先更新 task；命中 freeze-required 時停手取得使用者確認。
- 是 fix 或新增／修正可測試行為但未選取對應 capability 時，在 `workflow_decision` 說明為何採用替代驗證；skill 的存在不算已執行證據。
- 跑 pre-review 之前依 Lookup 結果處理受影響文件：命中且事實仍成立記 no-op、已失準就更新、`uncovered` 依判準決定要不要建立。判斷結果一律寫進 `## Project docs` 的 `updated:`（Elevated 另加 `read:`），Standard task 也要填。判準見 [project-docs skill](../project-docs/SKILL.md)。

## 6. 驗證與 pre-review

diff 完成後執行相關測試與 `agent-workflow pre-review --path <repo-root>`。`pre-review` 本身只跑 `git diff --check`（whitespace 與 conflict marker）；專案自己的 lint、build 與測試由主對話依實際 stack 決定並執行，結果一併寫入 `Validation results`。

- FAIL：停止，修正後重跑，不送 Reviewer 也不結案。
- SKIP：記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。

Review 前確認 diff 已穩定的做法見 [elevated.md](elevated.md)。

## 7. 記錄 evidence

對每個 evidence step 執行 `agent-workflow evidence-record --requirement-id <capability.step> --summary <結論與依據>`；step 實際跑過指令（測試／build／lint／migration dry-run／operational verification）時另加 `--command --cwd --exit-code --started-at --duration-ms --output-digest`，把它記成 execution evidence 而非分析結論。

policy 宣告 `runtime_execution` 的 step 改用 `agent-workflow evidence-run --requirement-id <capability.step> --summary <結論> -- <指令>`，由 runtime 實際執行並記下 exit code、耗時與輸出 digest。

角色用 `agent-workflow review-record --role <name> --result pass --summary <結論>`。這三個 command 自己算 hash、timestamp 與 diff 範圍，不接受呼叫端傳入。分類一改或審查範圍內的檔案再變動，gate 就要求重驗。

## 8. Reviewer

只有 `reviewer` 被 `required` 或被 `workflow_request` 加選時才啟動獨立唯讀複審；一般 task 的自我檢查由主對話直接完成。每個 task 只跑一位 reviewer，runtime contract 只認得 `role.reviewer` 一種身份。

執行方式、對抗式指令、round 記錄與 delta-first 複查規則見 [review.md](review.md)。

## 9. 失敗、續作與完成

- 同一修復假說失敗兩次就不再猜第三次，回到 [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md) 一次排出 3–5 個可證偽的假設。
- Review 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `pause`，缺權限、環境或外部決策用 `block`；兩者都必須填 `lifecycle.stop_reason`（在等什麼、下一步是什麼）。確定不做了用 `supersede`。
- 行為正確但沒有測試守住時記為測試缺口：有測試基礎設施且落在本次範圍內就退回補齊並重跑驗證；缺少基礎設施或需新增框架才做得到時不擴張範圍，在 `Validation results` 記錄替代驗證、未覆蓋行為與原因，是否另開任務由使用者決定。
- 完成條件、驗證與 Review 都完成後執行 `agent-workflow close-task`；`closed` 是唯一終態，只能透過 `close-task` 寫入。Elevated 與 coordinator／worker task 另見 [elevated.md](elevated.md)。
- 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。

## 10. 平行編排

每個 code task 開始前做一次輕量拆分評估：是否存在至少兩個互不重疊、可獨立驗收、且各自需要不同檔案範圍的子功能。不適合拆分就記為循序處理，不增加詢問成本。符合資格時建立 worker worktree 並派發；worker 只做 implementation，主對話整合後才執行選定的 Review 與驗證。細節見 [orchestration.md](orchestration.md)。
