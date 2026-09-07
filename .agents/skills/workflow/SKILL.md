---
name: workflow
description: 由 managed_change 決定是否進入 managed workflow，再由主對話依實際 impact 與 risk 選擇 capability。純文件、唯讀分析與不降低驗證能力的 test-only 修改 bypass；可能影響執行、資料、契約、安全性、部署、交付或 test integrity 的修改進入 workflow。
---

# agent-workflow
Optional push-back skill applies only when a chosen design may violate conventions or add unnecessary complexity.

修改本 framework 的 agents、skills、hooks 或 workflow contract 前，先讀 [architecture.md](../../../docs/architecture.md)。

task.md／task.json 的分工見 architecture.md；下文欄位名稱（`code_change`、`managed_change`、`workflow_request`、`risk_flags`、`impact_scope`、`impact_effect`、`workflow_facts` 等分類與 lifecycle 欄位）一律指同目錄 `task.json`（`schemas/task.schema.json`）裡的欄位，task.md 只保留 Goal／Scope／Completion criteria 與各 evidence section。task.json 一律由 runtime CLI 寫入，不得直接編輯：建立用 `task-init`；分類欄位（`code_change`／`managed_change`／`task_type`／`impact_scope`／`impact_effect`／`impact_confidence`／`risk_flags`／`workflow_facts`／`workflow_request`／`workflow_decision`）用 `task-write`（stdin 傳 JSON patch，經 schema 驗證與 lock 才落地）；`task-write` 拒絕兩種降級——`managed_change` 由 `true` 改回 `false`、移除既有 `risk_flags`——確實重新評估過才改用 `reclassify`，它要求 `--confirmed-by-user` 與 `--reason`，並把這筆決定記進 `workflow_decision`；`impact_confidence` 不在受保護之列，調低它會讓 gate 要求更多（`medium`／`low` 會 required `impact_discovery` 與 `baseline_validation`），屬於 agent 自己的分析狀態，可隨分析結果直接用 `task-write` 改；`intent_approval` 用 `approve-intent`；evidence 用 `evidence-record`（step）／`review-record`（role）——這三個 command 自己算 hash／timestamp／diff 範圍，不接受呼叫端傳入；狀態轉換用 `pause`／`block`／`resume`／`supersede`／`waive`／`close-task`；`resume` 把 `paused`／`blocked` 帶回 `in_progress`，worktree lease 在 `paused`／`blocked` 期間持續保留，不需要重新取得。`closed`／`superseded` 是終端狀態，任何 task state 寫入一律拒絕，要繼續處理就另建新 task；`paused`／`blocked` 期間仍可用 `task-write`／`reclassify` 修分類，但 `evidence-record`／`evidence-run`／`review-record`／`approve-intent`／`waive` 都要先 `resume` 回 `in_progress`。hook 會 fail-closed 擋下對 task.json 的直接檔案寫入工具呼叫。

## 適用範圍

`code_change` 與 `managed_change` 是兩個獨立欄位。

`code_change` 只描述這次是否修改「目標專案」的 application source code；它不決定是否進入 workflow。

`managed_change` 是 managed workflow 唯一 entry gate。

以下情況通常是 `managed_change: true`：

- 修改 application source code 並可能改變實際行為。
- 修改資料、schema、migration 或持久化行為。
- 修改公開契約、授權、安全性或跨功能行為。
- 修改 CI/CD、Dockerfile、nginx、Terraform、deploy script 或其他可能改變部署／執行結果的設定。
- 修改測試時降低或重新定義既有驗證可信度。

以下情況通常是 `managed_change: false`：

- 純文件或註解。
- 純 read-only 分析、review、規劃、問答或翻譯。
- 只新增測試。
- 只強化既有 assertion。
- 不降低驗證能力的 test refactor、fixture 維護或測試結構整理。

Config、script 或其他 non-application-source change 依是否可能改變部署、執行、資料或交付結果判斷，不以「不是程式碼」作為 unmanaged 的依據。

Test-only change 只有在降低或大幅改變既有驗證可信度時才進 managed workflow，包括：

- 刪除既有測試。
- skip／disable 既有測試。
- 弱化 assertion。
- 大量重寫 snapshot／fixture，使既有 regression baseline 被重新定義。

這類 task 使用：

- `code_change: false`
- `managed_change: true`
- `task_type: chore`
- `risk_flags: ["test_integrity"]`

並依實際情況設定：

- `workflow_facts.test_deleted`
- `workflow_facts.test_skipped`
- `workflow_facts.assertion_weakened`
- `workflow_facts.snapshot_mass_change`

runtime 再依 `test_integrity` capability 展開對應 evidence step。

既有或匯入的 `managed_change: false` task 僅作相容性資料，不啟動 capability 或角色：`required`、`suggested`、`selected`、`order` 與 evidence 清單一律為空，`workflow_request` 只保留為輸入紀錄，不影響 plan。

一般的唯讀問答、分析與 review 就是 unmanaged，直接 bypass，不建立 task，由 host 選用唯讀 reader agent。`task_type: read_only` 只用於本來就存在 task record 的唯讀、orchestration 或 legacy 情境；此時 `model_profile` 由 runtime 依 `impact_scope`／`impact_effect`／`risk_flags` 推導，不由 agent 指定。

如果原先判定為 unmanaged，但處理過程中發現實際會改變 runtime behavior、delivery behavior 或 verification integrity，使用 `task-write` 將同一 task 的 `managed_change` 改為 `true`。

若同時涉及 application source code，再一併把 `code_change` 改為 `true`。`code_change: false -> true` 時 runtime 會執行 worktree lease、dirty check 與 `base_commit` 綁定。

`code_change` 只能由 `false -> true`；已經是 `true` 就維持 `true`。如果整個 task 分類錯誤，需要放棄目前 delivery，使用 `supersede` 後建立新 task。

### 流程層級

Workflow 沒有固定 pipeline，也沒有預設檔位。十六個 capability：`baseline_validation`、`impact_discovery`、`codebase_design`、`bug_diagnosis`、`tdd`、`schema_compatibility`、`migration_safety`、`data_impact`、`contract_review`、`execution_path_review`、`regression_validation`、`test_integrity`、`mutation_validation`、`security_review`、`operational_verification`（`kind: evidence`，產出寫在各自 section 的 `- <step id>:` 行）與 `reviewer`（`kind: role`，獨立唯讀複審，定義與執行方式見 §6）。`required`／`suggested`／`selected` 如何算出、step 如何依 `when` 展開、以及各情境的典型組合與成本，見 [capability-selection.md](capability-selection.md)。

`baseline_validation` 依分類選取，不再只因 `managed_change: true` 就無條件 required：`impact_confidence` 為 `medium`／`low`、`impact_scope` 達 `multi_module`、`impact_effect` 屬 `shared_behavior`／`schema`／`data`／`contract`／`destructive`，或命中高風險 `risk_flags`（`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`test_integrity`、`security`、`operational`）時才會選取。單檔、局部行為、高信心且無 risk flag 的 managed change `required` 為空，要跑哪些測試、要不要 review 或 diagnosis 由主對話自行決定，需要時用 `workflow_request` 加選。BV1 指出實際被執行到的 entrypoint 與受影響執行路徑，BV2 用 `evidence-run` 跑最小可重現驗證（該 step 宣告 `runtime_execution`，只接受 runtime 觀測到的 evidence，agent 自述的分析結論不算數），BV3 列出已知限制與本次未驗證的項目。

`mutation_validation`（`financial`／`irreversible` 觸發；一般 `data_write` 由 `data_impact` 涵蓋，判斷確實需要時才用 `workflow_request` 加選）確認 mutation target、失敗與回滾行為、破壞性路徑的測試是否真的守得住，MV4 宣告 `runtime_execution`。`security_review`（`security`／`authorization` 觸發）走 SR1–SR5：授權邊界、輸入信任邊界、秘密處理、指令執行、檔案系統路徑。`operational_verification`（`operational` 觸發）走 OV1–OV4：部署與 runtime 設定、服務啟動與網路可達（OV2 宣告 `runtime_execution`）、CI/CD 路徑、目標環境實際行為。

`codebase_design` 用於 interface、seam、adapter、testability 或 shared logic 的設計判斷，選取後載入 [codebase-design skill](../codebase-design/SKILL.md)：主對話界定 interface 與 seam，Review 檢查 depth、delete test 與是否過早抽象化，並確認測試透過 interface 驗證可觀察結果。

`bug_diagnosis` 用於重現、最小化與假設驗證，選取時載入 [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md)，以 task 的 `Bug diagnosis` section 記錄 feedback loop、repro、假設、probe 與回歸結果；`tdd` 用於 red → green → refactor、seam 與測試缺口證據，選取時載入 [TDD skill](../tdd/SKILL.md)，以 `TDD evidence` section 記錄 red、green、seam 與測試缺口。這三者都是可選 capability，不會只因為出現 `interface`、`fix` 或 `test` 等單一字詞就自動觸發；`bug_diagnosis` 通常用於 `task_type: fix`、效能異常或明確的 debug／diagnose 任務，`tdd` 通常用於 feature、fix、行為變更或使用者要求 test-first 的任務，是否選取仍由主對話根據實際影響決定。

前置決策 skill 不建立獨立 task section：架構設計、feature planning、refactor 策略或 `unclear_requirements` 先載入 [planning skill](../planning/SKILL.md)；使用者已選定的方案涉及新增 abstraction、interface、adapter、wrapper、cross-layer seam 或可疑複雜度時，先載入 [push-back skill](../push-back/SKILL.md) 檢查最小方案。遇到高風險且不可逆的未決取捨，再載入 [grill-me skill](../grill-me/SKILL.md) 逐題釐清。

## 1. 建立 Task

1. Standard task 直接沿用已知的 task context；只有需要跨 worktree、coordinator／worker 或 legacy runtime gate 時才執行 `agent-workflow project-resolver -Ensure`。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作，需要時用 `resume` 接回。不是續作時，`paused` 與 `blocked` 仍持續佔用該 worktree 的 code task lease（下一個 code task 無法在同一 worktree 建立）；要讓另一個 code task 使用同一 worktree，須先釋放舊 task 的 lease——放棄舊 task 用 `supersede`，確定要完成舊 task 則先 `resume` 回 `in_progress` 再 `close-task`（`paused`／`blocked` 無法直接轉為 `closed`）；否則改用不同的 worktree。
3. 預期會修改架構、契約或跨模組行為時，先讀 [elevated.md](elevated.md) 的建立前規則；project docs 讀寫時機另見 [project-docs skill](../project-docs/SKILL.md)。
4. Standard task 依 `templates/task-minimal.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`；Elevated、coordinator／worker 或需 legacy gate 的 task 依 `templates/task.md` 建立 extended task。同一目錄執行 `agent-workflow task-init --task-path <dir>`（stdin 傳初始欄位的 JSON，`id` 自動取目錄名）建立 `task.json`；預設 `status: in_progress`，欄位需符合 `schemas/task.schema.json`。
5. 建立 task 前先判斷 `managed_change`。若為 `false`，直接 bypass，不建立 task。若為 `true`，建立 task 時一次填入目前已知的 classification。`code_change` 只表示是否修改 application source code，不再負責 workflow entry。Test-only 的 `test_integrity` task 使用 `code_change: false`、`managed_change: true`；application source code task 通常使用 `code_change: true`、`managed_change: true`。所有新 managed task 使用 `workflow_mode: main`，並填入主對話選定的 `workflow_request`。`task_type` 是唯一的變更分類欄位，`code_change: true` 結案時必填。
6. 命中 freeze-required flag 時 `intent_approval` 先留空，取得使用者對目標、非目標與完成條件的確認後才執行 `approve-intent --confirmed-by <who> --as-user`（見 [risk-flags.md](risk-flags.md)）；runtime 只算 task.md 的 Goal／Scope／Completion criteria 三段內容的 hash（`intent_hash`），改錯字或補其他 section 不影響既有 approval，改動這三段才會讓它失效，task-gate 憑此放行。命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標與限制，必要時加開 `grill-me` skill 壓力測試計畫（見 [risk-flags.md](risk-flags.md)）。

## 2. 記憶

1. 只有任務依賴歷史脈絡、使用者要求或已知回歸時，才以 2–5 個關鍵字執行 `agent-workflow knowledge --action Search --query '<keywords>' --limit 5`；簡單、局部且不依賴歷史的修改略過。
2. Query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文與整串連字號的命中率極低）。Search 只回傳 entry 第一行前 180 字，命中後要 Read `path` 全文。
3. Managed hook 會自動執行 `memory-context`：Claude／Codex 在 `SessionStart`，Antigravity 沒有 session lifecycle event，改掛在 `PreInvocation` 並只在該 conversation 的第一次 model invocation 掃描，讀取共用 curated store 與可讀的原生 Markdown／text 記憶並注入 reference context。原生記憶只讀不寫，標記 `needs_verification`，不會被複製進 curated store；session summaries、instruction-only files、credential-like content 與 Antigravity `.pb` 檔案預設排除。完整內容仍可用 Search 回查 `path`。
4. 專案結構與模組流程不走 knowledge，改走 project docs（讀寫時機見第 1、4 節，分工與寫法見 [project-docs skill](../project-docs/SKILL.md)）。
5. Review 可自行執行 Search 建立脈絡。
6. `needs_verification` 或可能過時的記憶只能當線索，使用前回查目前程式、文件或設定。
7. 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 `agent-workflow learn --action Capture` 寫入目前 project；跨專案偏好或通用教訓才寫入 Global。沒有耐久價值時不增加任何步驟。
8. 同 topic 由 script 更新既有 native entry；相同內容自動去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `--approved-by-user`。
9. 有寫入時在回覆中簡短告知摘要；禁止寫入秘密、token、密碼、連線字串或個資。`learn` 會依 content hash 去重。

## 3. Risk Flags

依實際風險判斷是否加入 `risk_flags`，不為湊流程加 flag。允許值、各值定義與對應要求見 [risk-flags.md](risk-flags.md)。

角色與 capability 啟動規則見「流程層級」一節。是否進入本流程只看 `managed_change`。

## 4. 實作

Elevated task 另有建立前與實作前規則見 [elevated.md](elevated.md)（project docs lookup、`Impact surface` 反向搜尋、完整 execution path）；以下適用所有 task。

- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍；若發現架構或影響面不明，升級為 Elevated task。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- 修改 application source code logic 前，一律載入 [clean-comments skill](../clean-comments/SKILL.md)；test code 與其他 non-code task 不適用。
- `workflow_request` 選取 `bug_diagnosis` 時，載入 [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md)：先建立一個對這個 bug 會變紅的 feedback loop，再重現、最小化、產生排序過的假設，不得跳過直接猜。修改後執行相關驗證，無法自動化時在 task 記錄替代驗證與原因。
- `workflow_request` 選取 `tdd` 時，載入並遵循 [TDD skill](../tdd/SKILL.md) 的 red → green → refactor、seam、測試設計與 mock 規則。純測試重整或無法自動化時記錄替代驗證與原因；所有進入 workflow 的 source-code task 仍須執行相關驗證。
- 若 task 是 fix 或新增／修正可測試行為但未選取對應 capability，主對話在 `workflow_decision` 說明為何採用替代驗證；不能把 skill 的存在當成已執行證據。
- 架構設計、feature planning、refactor 策略或 `unclear_requirements` 時先載入 [planning skill](../planning/SKILL.md)；使用者已選定方案且涉及新增 abstraction、interface、adapter、wrapper、cross-layer seam 或可疑複雜度時先載入 [push-back skill](../push-back/SKILL.md)，在實作前完成取捨檢查。
- 若本次新增或修改程式碼註解，依已載入的 [clean-comments skill](../clean-comments/SKILL.md) 執行：函式註解只講對外合約、流程註解就近解釋 Why，不堆內部步驟流水帳。
- 發現新 hard-risk flag 時先更新 task；若需凍結則停手取得使用者確認。
- 動手前先跑一次 `project-doc --action Lookup`，在跑 pre-review 之前依查詢結果處理受影響文件（原料是 `Impact surface` 與 `Execution path`）：命中且事實仍成立記 no-op、已失準就更新、`uncovered` 就建立。是否要讀、要不要動文件仍是判斷題，但判斷完的結果一律寫進 `## Project docs` 的 `updated:`（Elevated 另加 `read:`）——**這行 Standard task 也要填，不因為用 `task-minimal.md` 就省略**，沒有文件變動時寫具體原因而非留空。判斷細節見 [project-docs skill](../project-docs/SKILL.md)。

## 5. Pre-review

Standard source-code task 在 diff 完成後執行相關測試與必要的 `agent-workflow pre-review --path <repo-root>`；Elevated task 再依 risk flag 執行完整 deterministic checks。`pre-review` 本身只跑 `git diff --check`（whitespace 與 conflict marker），專案自己的 lint、build 與測試仍由主對話依實際 stack 決定並執行，結果一併寫入 `Validation results`。`managed_change: false` 的任務不因本 skill 建立 task 或執行 pre-review。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。
- Review 前確認 diff 已經穩定的做法見 [elevated.md](elevated.md)；一般 task 以最後一次驗證與角色結果為準。
- `financial`、`data_write` 或 `irreversible` 命中時 runtime 會強制 `mutation_validation` capability，MV3 就是那次 mutation check：把本次最關鍵的 1–2 個判斷人為改壞，確認守住它的測試真的變紅，再還原。測試全綠但斷言恆真、或 fixture 寫死成通過形狀，只有這一步抓得到。觸發集合的權威來源是 `schemas/workflow-policy.json` 的 `require_when`。

## 6. Review

`reviewer` 是獨立的唯讀複審角色：只讀 diff 與相關程式碼並回報結論，本身不改動任何檔案，可以派成 subagent 執行。主對話是 coordinator，負責整合複審結果並做最後一次合理性核對；coordinator 這一趟屬於整合工作，不算第二位 reviewer。

每個 task 只跑一位 reviewer。Runtime contract 只認得 `role.reviewer` 一種身份，第二位 reviewer 就算真的跑了也無法被證明，因此高風險情境改成把對抗式要求寫進同一位 reviewer 的指令，而不是另開角色。reviewer 回報 blocker 並修正後，重新執行同一個 reviewer capability 即可。

一般 task 的自我檢查由主對話直接完成；只有 reviewer 被 `required`（高 blast radius 或高風險分類）或被 `workflow_request` 加選時，才另外啟動獨立唯讀 Reviewer。

bug fix 或邏輯調整仍須依第 4 節 TDD 規則補測試。

### Review 的執行方式

Review 由 reviewer 走一趟、coordinator 再整合核對一趟，兩者盲點互補：獨立 reviewer 抓得到主對話因為熟悉而略過的死碼與慣例偏離，coordinator 抓得到 reviewer 缺少專案脈絡而串不起來的跨檔案語意問題。

reviewer 這一趟派一般 subagent（`general-purpose`），指令載明這兩項要求：

- 實際執行既有的相關測試。數值、邊界與併發行為若現有測試沒有涵蓋，列為測試缺口並指出應補的具體案例，由實作者依 TDD 補齊。
- 對改動的欄位與資料流，往上下游追到 repository 與 entity，確認欄位映射、呼叫端與程式宣稱的行為一致。

高風險分類把要主動推翻的假設直接寫進同一位 reviewer 的指令，不另開角色：

- `financial`／`data_write`／`schema`／`migration`：推翻資料 provenance、rollback 路徑與 invariants。
- `security`／`authorization`：推翻 trust boundary 與權限假設。
- `contract`：主動尋找 consumer 的相容性破口。
- `ui`：依 risk-flags.md 用 browser 實際驗證，不以靜態閱讀代替。

coordinator 這一趟由主對話自己對照完整 diff 走一次，聚焦 subagent 缺乏專案脈絡而判斷不了的部分：與既有慣例是否一致、跨檔案的語意衝突、本次改動與既有功能是否重複或互相覆蓋。

各趟結果合併寫入 `## Reviewer result`：`- result:` 記 PASS 或 FAIL，`- findings:` 只列 blocker，每項附 path、symbol／hunk、可觸發情境、影響與最小修正方向；沒有 blocker 時 findings 記 none。

- Review 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task；不得為了避開 gate 而不加 flag。
- 回填後的 task 路徑即為唯一版本，後續複審與 knowledge 回寫都以它為準；差異只存在於審查當下，不留到下游。
- Review 有 blocker：主 agent 修正，重新執行相關驗證，再重跑上述各趟。
- 行為正確但沒有測試守住時記為測試缺口：專案已有可用測試基礎設施且補測試落在本次範圍內時退回補齊，重跑 pre-review 與相關驗證；缺少測試基礎設施、或需新增框架或重構才做得到時不擴張範圍，在 `Validation results` 記錄替代驗證、未覆蓋行為與原因，並依第 8 節寫入 knowledge。是否另開任務補齊由使用者決定，不得逕自結案或悄悄降低完成條件。

### 6b. Review round 與增量錨定

第一輪依 §6 建立脈絡。Blocker 修正後，後續輪次在 task.md 的 `## Review round` 記錄前一輪 finding、本輪 fix delta、impact delta、重新執行的驗證與未確認節點；可用它導航，但仍須自行核對 diff，不得把 task 敘述當成正確性證據。

開下一輪前先做歸因：這次被打回，是當初缺文件、任務描述沒講清楚、慣例沒寫成規範、有文件規範但沒讀到，還是單純寫錯。執行 `review-cause --action Record --task-path <task> --round <n> --cause <cause> --evidence <當初缺的是什麼> --paths <本次改動路徑>`，把回傳的 id 填進該輪的 `- cause:`。分類定義與累積後的補救路由見 `schemas/review-cause.schema.json` 與 [distill skill](../distill/SKILL.md)。

後續輪次採 delta-first：先檢查修復項、直接呼叫端與本輪新增波及項，不重複輸出未變更內容。若修改入口、公開介面、共用狀態、資料／契約、並發／非同步／錯誤邊界，或前輪存在未確認節點，則重新展開完整 execution path。Diff anchor 使用 repo-relative path、symbol 與 diff hunk，不得只依賴行號。

subagent 回報只保留錯誤：有 finding、blocker、FAIL 或未驗證限制時，輸出具體錯誤、依據、影響與可重現位置，省略所有 PASS 項目；全部通過時只輸出單行 `PASS`。不得以固定 token 截斷輸出。Task 內仍依 schema 回填必要的機械檢查欄位。

## 7. 失敗與續作

- 同一修復假說失敗兩次，不再猜第三次；回到 [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md) 的 Phase 3，一次排出 3–5 個可證偽的假設，不要繼續單一假設式猜測。
- Review 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `paused`；缺權限、環境或外部決策用 `blocked`。兩者都必須在 task.json 填 `lifecycle.stop_reason`（在等什麼、下一步是什麼）；沒填時下次同一 worktree 的 Stop 會提示一次（同一 session 只提示一次），提醒補上，不阻斷結束回合。確定不做了用 `superseded`。
- task.md 保存人的意圖與驗收條件，task.json 保存版本化 lifecycle、workflow 分類、evidence 與 waiver；兩者分工見 [architecture.md](../../../docs/architecture.md)。

## 8. 完成

1. 對照 task 完成條件，填入 pre-review、其他實際指令、結果與未驗證限制。
2. 對每個 evidence-capability step 執行 `evidence-record --requirement-id <capability.step> --summary <結論與依據>`；step 實際跑過指令（測試／build／lint／migration dry-run／operational verification）時，另加 `--command --cwd --exit-code --started-at --duration-ms --output-digest` 把它記成 execution evidence，而非單純分析結論；宣告 `runtime_execution` 的 step（如 `baseline_validation.BV2`）改用 `agent-workflow evidence-run --requirement-id <capability.step> --summary <結論> -- <指令>`，由 runtime 實際執行該指令並記下 exit code、耗時與輸出 digest，agent 不能自行填寫；對 `workflow_request` 選中的角色（如 `reviewer`）執行 `review-record --role <name> --result pass|fail --summary <結論>`——`plan_hash`／`at`／`reviewed_base`／`reviewed_paths`／`reviewed_diff_sha256`／`delivery_hash` 一律由 runtime 現算現寫，不再手動跑 `worktree-fingerprint` 後拼進 patch。分類一改或審查範圍內的檔案再變動，gate 就要求重驗。coordinator／worker 或 legacy completion gate 另需 `independence` 狀態，見 [elevated.md](elevated.md)。
3. Review 打回的歸因已在 §6b 每輪記錄。只有疑似 regression、同一問題反覆修正或使用者要求時，另由主對話做回歸歸因，結果寫入 `## Retrospective result`：查不到引入點就寫 `unknown` 並列出跑過的搜尋，framework change 需指名哪個檔案的哪一條規則要改成什麼。確認 regression 才執行 `agent-workflow retro --action Record`。
4. Standard task 在完成條件、驗證與 Review 都完成後執行 `agent-workflow close-task` 把 `lifecycle.status` 轉為 `closed`（`lifecycle.status` 沒有 `done` 這個值，唯一的終態是 `closed`，且只能透過 `close-task` 寫入，不得直接編輯 task.json）；coordinator／worker 或 Elevated task 走同一個 `close-task`，另需重跑完整 legacy gate（見 [elevated.md](elevated.md)）。工作停在半途用 `paused`，缺外部條件用 `blocked`。
5. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。
6. Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `knowledge --action Upsert --scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑；單次筆誤或單點邏輯錯誤不寫。

## 9. 平行編排

每次開始 code task 的開發前，主對話都要先做一次輕量拆分評估：確認是否存在至少兩個互不重疊、可獨立驗收、且各自需要不同檔案／模組範圍的子功能。明確不適合拆分時直接記為循序處理，不增加詢問與 orchestration 成本。

主對話在每個 code task 開始時自動完成拆分評估；若拆分規格符合資格，直接建立 worker worktree 並派發。具備 host-native agent collaboration 時優先使用它；只有要由 runtime 建立 detached worktree 並跨平台派發時才需要設定 dispatcher。worker 只做 implementation，不跑測試或角色；主對話整合並補齊全部完成條件後，才執行選定的 Review 與驗證。詳細 Git snapshot、平台 adapter 與失敗處理見 [orchestration.md](orchestration.md)。
