---
name: workflow
description: 實際修改 application source code logic 時，由主對話依觀察到的 impact 與 risk 判斷是否建立 task、選擇要跑的 capability 與角色；isolated 且無明確風險的修改可採最小驗證。純 test code 修改與其他非程式碼邏輯任務 bypass workflow，但仍應執行相關測試或必要驗證。
---

# agent-workflow
Optional push-back skill applies only when a chosen design may violate conventions or add unnecessary complexity.

修改本 framework 的 agents、skills、hooks 或 workflow contract 前，先讀 [architecture.md](../../../docs/architecture.md)。

task.md／task.json 的分工見 architecture.md；下文欄位名稱（`code_change`、`workflow_request`、`risk_flags`、`impact_scope`、`impact_effect`、`workflow_facts` 等分類與 lifecycle 欄位）一律指同目錄 `task.json`（`schemas/task.schema.json`）裡的欄位，task.md 只保留 Goal／Scope／Completion criteria 與各 evidence section。task.json 一律由 runtime CLI 寫入，不得直接編輯：建立用 `task-init`，之後改任一欄位用 `task-write`（stdin 傳 JSON patch，經 schema 驗證與 lock 才落地），狀態轉換用 `pause`／`block`／`supersede`／`waive`／`close-task`；hook 會 fail-closed 擋下對 task.json 的直接檔案寫入工具呼叫。

## 適用範圍

實際修改「目標專案」的 application source code logic 時，由主對話根據觀察到的 impact 與 risk 判斷是否建立 task、選擇要跑的 capability 或角色；isolated 且無明確風險的修改可採最小驗證。純 test code 修改仍應執行相關測試，但直接 bypass：不建立 task、不啟動角色，由主對話處理。既有或匯入的 `code_change: false` task 僅作相容性資料，不啟動角色。判斷為 non-code 後若在處理過程中發現實際需要改 application source code 邏輯（原判斷有誤），不得沿用原 task 補角色：另建 `code_change: true` 的新 task 走完整流程，原 task 標記 `superseded` 並在其中註明轉出的新 task。

### 流程層級

Workflow 沒有固定 pipeline，也沒有預設檔位。runtime 依 `risk_flags` 透過 `workflow-policy.json` 的 `require_when` 算出一組 `required` capability，這是不可省略的下限；主對話依已知需求與程式脈絡，在 `workflow_request` 裡疊加想額外執行的 capability，只能加、不能拿掉 `required` 命中的項目。單純不把某個 capability 寫進 `workflow_request` 並不會讓它從 gate 消失——`required` 由 risk flags 直接算出，要移除只能明確執行 `waive`（需 `--confirmed-by-user`），而這個 waiver 綁定當下的 `requirements_hash`，task 的分類一變（risk flags、`impact_scope`、`impact_effect` 等任何進到 hash 的欄位改變）就自動失效，需重新確認。

**外層選取（跑哪些 capability）**：Planner 先依 task metadata 與 `workflow_facts` 產生 `suggested` 候選，主對話再確認、覆寫或補充，寫入 `workflow_request`；runtime 再把 `required` 與 `workflow_request` 合併成最終 `selected`。`required` 為空時任何組合都合法——只跑 evidence capability 而沒有 `reviewer`、或一個都不跑（此時 `## Impact surface` 必填，說明為何判斷這個 task 不需要任何 capability），都是正常結果；`required` 非空時，`selected` 至少涵蓋這些項目，`workflow_request` 只能疊加、不能覆寫。

**交付批次與角色時機**：角色以一個 task 的最終可交付 diff 為單位選取與執行。任務拆成多個實作階段時，各階段只完成其局部測試與必要驗證；待所有階段整合、完成條件與完整 execution path 穩定後，才對整體變更集執行 Review。若某階段會獨立發布、不可逆地寫入外部系統，或其產物已成為後續階段不可回溯的前提，則將它視為獨立交付批次並在該批次完成前執行必要角色。finding 修正後依 §6b 做 delta-first 複查；只有入口、公開介面、共用狀態、資料／契約、並發／非同步或錯誤邊界改變時，才重新展開完整路徑。

**內層選取（跑該 capability 的哪些 step）**：capability 一旦被選中，它底下哪些 step 需要填，由 policy 內每個 step 的 `when` 依 `impact_scope`／`impact_effect`／`change_kind`／`risk_flags`／`workflow_facts` 這組宣告值決定。例如 `execution_path_review` 在 `impact_scope: file` 且 `change_kind: fix` 時只需要 EP1，在 `impact_scope: cross_project` 且 `change_kind: refactor` 時展開 EP1–EP5。這一層只會**減少**要寫的 evidence 行數，不會影響最終 capability 是否被選中——最終選取仍以 `workflow_request` 為準。`workflow_facts` 裡沒宣告的欄位一律保留對應的 step（unknown 不等於「不需要」），但已宣告為真的 fact 可以產生 capability 候選建議。

十一個 capability：`impact_discovery`、`codebase_design`、`bug_diagnosis`、`tdd`、`schema_compatibility`、`migration_safety`、`data_impact`、`contract_review`、`execution_path_review`、`regression_validation`（`kind: evidence`，產出寫在各自 section 的 `- <step id>:` 行）與 `reviewer`（`kind: role`，由主對話依 §6 執行）。`codebase_design` 用於 interface、seam、adapter、testability 或 shared logic 的設計判斷；`bug_diagnosis` 用於重現、最小化與假設驗證；`tdd` 用於 red → green → refactor、seam 與測試缺口證據。這三者都是可選 capability，不會只因為出現 `interface`、`fix` 或 `test` 等單一字詞就自動觸發。`order_after` 只決定順序，不會把缺席的前置補回來。完整的 step 清單與 `when` 條件見 `schemas/workflow-policy.json`。

選取 `codebase_design` 後，角色依自己的責任載入同一份 [codebase-design skill](../codebase-design/SKILL.md)：Planner／主對話界定 interface 與 seam，Review 檢查 depth、delete test 與是否過早抽象化，並確認測試透過 interface 驗證可觀察結果。

選取 `bug_diagnosis` 時載入 [diagnosing-bugs skill](../diagnosing-bugs/SKILL.md)，以 task 的 `Bug diagnosis` section 記錄 feedback loop、repro、假設、probe 與回歸結果；選取 `tdd` 時載入 [TDD skill](../tdd/SKILL.md)，以 `TDD evidence` section 記錄 red、green、seam 與測試缺口。`bug_diagnosis` 通常用於 `change_kind: fix`、效能異常或明確的 debug／diagnose 任務；`tdd` 通常用於 feature、fix、行為變更或使用者要求 test-first 的任務，是否選取仍由主對話根據實際影響決定。

前置決策 skill 不建立獨立 task section：架構設計、feature planning、refactor 策略或 `unclear_requirements` 先載入 [planning skill](../planning/SKILL.md)；使用者已選定的方案涉及新增 abstraction、interface、adapter、wrapper、cross-layer seam 或可疑複雜度時，先載入 [push-back skill](../push-back/SKILL.md) 檢查最小方案。遇到高風險且不可逆的未決取捨，再載入 [grill-me skill](../grill-me/SKILL.md) 逐題釐清。

Evidence capability 只在影響確實擴散時才登場，一般 code change 的成本很低：

| 情境 | 典型組合 | evidence step 數 |
|---|---|---|
| 單檔 bug fix、模組內小功能 | `reviewer` | 0 |
| 判斷為 isolated 的小改動（例如無 consumer 的 additive 欄位） | 無 capability ＋ `Impact surface` 說明判斷依據 | 0 |
| 邏輯單純但需實測、無呼叫端 | `reviewer` | 0 |
| 跨模組 refactor | `execution_path_review` → `regression_validation` → `reviewer` | 10 |
| 金流狀態機 | `data_impact` → `execution_path_review` → `regression_validation` → `reviewer` | 14 |
| 大表 migration + backfill | `execution_path_review` → `schema_compatibility` → `data_impact` → `migration_safety` → `reviewer` | 20 |
| coordinator／worker | 依上列規則，另加 orchestration 與 legacy close gate（見 [elevated.md](elevated.md)） | 依上列規則 |

Reviewer 用於判斷完整 diff 是否符合需求、影響面與失敗模式，並從 real entrypoint 確認完成條件與可觀察結果。命中 `financial`、`data_write`、`migration`、`irreversible`、`schema`、`contract` 時，在 §6 第一趟的指令裡明寫要推翻的資料溯源、底層語意或同型擴散假設。每列都是最終交付批次的典型組合，不是逐一實作階段的 pipeline。

`workflow-plan` 會輸出 `suggested`、`requested`、`selected` 與 `order`，供主對話在建立或更新 task 前檢查候選。`workflow_request` 是主對話寫入、疊加在 `required` 之上的 capability 清單（例如 `[reviewer]`）；名稱 authority 是 `schemas/workflow-policy.json`，未知 capability 或無效 `workflow_facts` 直接回報 contract error。runtime 驗證的是 `required` ∪ `workflow_request` 合併後的 `selected` 清單執行結果是否齊全。沒有 `workflow_mode: main` 的既有 task（早於本機制的舊 task）不再走獨立的相容判斷：一律視為 `code_change: true` 就要求 `reviewer`，同樣沒有分別的流程分支。Retrospective 只在疑似 regression、同一問題反覆修正或使用者要求時啟動，不因每個 `fix` 自動加入。

## 1. 建立 Task

1. Standard task 直接沿用已知的 task context；只有需要跨 worktree、coordinator／worker 或 legacy runtime gate 時才執行 `~/.agent-workflow/runtime/agent_workflow.cmd project-resolver -Ensure`。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作；不是就先將舊 task 改為 `paused`、`blocked`、`done` 或 `superseded`。
3. 預期會修改架構、契約或跨模組行為時，先讀 [elevated.md](elevated.md) 的建立前規則；project docs 讀寫時機另見 [project-docs skill](../project-docs/SKILL.md)。
4. Standard task 依 `templates/task-minimal.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`；Elevated、coordinator／worker 或需 legacy gate 的 task 依 `templates/task.md` 建立 extended task。同一目錄執行 `agent-workflow task-init --task-path <dir>`（stdin 傳初始欄位的 JSON，`id` 自動取目錄名）建立 `task.json`；預設 `status: in_progress`，欄位需符合 `schemas/task.schema.json`。
5. 用 `task-write` 明確填寫 `code_change: true | false`：只有修改「目標專案」application source code 邏輯，且達到 workflow 觸發條件時為 `true`。純 test code 修改不建立 workflow task。新 code task 填 `workflow_mode: main` 與由主對話選定的 `workflow_request`。`change_kind: fix | feature | refactor | chore` 仍在 `code_change: true` 結案時必填。
6. 命中 freeze-required flag 時 `intent_approval` 先留空，取得使用者對目標、非目標與完成條件的確認後才用 `task-write` 寫入（見 [risk-flags.md](risk-flags.md)）；task-gate 憑 `intent_approval.intent_sha256` 是否等於當下 task.md 雜湊放行，並非每次工具寫入都由 runtime 攔截。命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標與限制，必要時加開 `grill-me` skill 壓力測試計畫（見 [risk-flags.md](risk-flags.md)）。

## 2. 記憶

1. 只有任務依賴歷史脈絡、使用者要求或已知回歸時，才以 2–5 個關鍵字執行 `~/.agent-workflow/runtime/agent_workflow.cmd knowledge --action Search --query '<keywords>' --limit 5`；簡單、局部且不依賴歷史的修改略過。
2. Query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文與整串連字號的命中率極低）。Search 只回傳 entry 第一行前 180 字，命中後要 Read `path` 全文。
3. 每次 session 啟動時，三平台 managed `SessionStart` hook 會自動執行 `memory-context`，讀取共用 curated store 與可讀的原生 Markdown／text 記憶並注入 reference context。原生記憶只讀不寫，標記 `needs_verification`，不會被複製進 curated store；session summaries、instruction-only files、credential-like content 與 Antigravity `.pb` 檔案預設排除。完整內容仍可用 Search 回查 `path`。
4. 專案結構與模組流程不走 knowledge，改走 project docs（讀寫時機見第 1、4 節，分工與寫法見 [project-docs skill](../project-docs/SKILL.md)）。
5. Review 可自行執行 Search 建立脈絡。
6. `needs_verification` 或可能過時的記憶只能當線索，使用前回查目前程式、文件或設定。
7. 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 `agent_workflow.cmd learn --action Capture` 寫入目前 project；跨專案偏好或通用教訓才寫入 Global。沒有耐久價值時不增加任何步驟。
8. 同 topic 由 script 更新既有 native entry；相同內容自動去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `--approved-by-user`。
9. 有寫入時在回覆中簡短告知摘要；禁止寫入秘密、token、密碼、連線字串或個資。`learn` 會依 content hash 去重。

## 3. Risk Flags

依實際風險判斷是否加入 `risk_flags`，不為湊流程加 flag。允許值、各值定義與對應要求見 [risk-flags.md](risk-flags.md)。

角色啟動規則（`workflow_request` 選取、三者互相獨立、舊 task legacy fallback）見「流程層級」一節；non-code task 永遠不進入本流程。

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

Standard source-code task 在 diff 完成後執行相關測試與必要的 `~/.agent-workflow/runtime/agent_workflow.cmd pre-review --repo-root <root>`；Elevated task 再依 risk flag 執行完整 deterministic checks。需要時可傳入 `--profile focused|affected|regression|full --path <repo-relative-path>`，runtime 會以 `AGENT_WORKFLOW_VALIDATION_PROFILE` 與 `AGENT_WORKFLOW_CHANGED_PATHS` 傳給 repo extra；未支援這些環境變數的 repo 維持既有命令。純 test code 與其他 non-code 任務不因本 skill 建立 task 或執行 pre-review。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。
- `diff_sha256` 記錄與比對只在 coordinator／worker 或明確啟用 legacy completion gate 時需要，見 [elevated.md](elevated.md)；一般 task 以最後一次驗證與角色結果為準。
- `financial` 或 `data_write` 命中時另做一次 mutation check：把本次最關鍵的 1–2 個判斷人為改壞，確認守住它的測試真的變紅，再還原，於 `- mutation check:` 記 PASS 或 SKIP＋理由。測試全綠但斷言恆真、或 fixture 寫死成通過形狀，只有這一步抓得到。權威清單是 `schemas/task.schema.json` 的 `x_agent_workflow.mutation_check_required`。

## 6. Review

選了 `reviewer` 時由主對話執行，不啟動獨立角色。bug fix 或邏輯調整仍須依第 4 節 TDD 規則補測試。

### Review 的執行方式

Review 跑兩趟，兩趟的盲點互補：獨立 subagent 抓得到主對話因為熟悉而略過的死碼與慣例偏離，主對話抓得到 subagent 缺少專案脈絡而串不起來的跨檔案語意問題。

第一趟派一般 subagent（`general-purpose`），指令載明這兩項要求：

- 實際執行既有的相關測試。數值、邊界與併發行為若現有測試沒有涵蓋，列為測試缺口並指出應補的具體案例，由實作者依 TDD 補齊。
- 對改動的欄位與資料流，往上下游追到 repository 與 entity，確認欄位映射、呼叫端與程式宣稱的行為一致。

需要對抗式複查（推翻資料溯源、底層語意、同型擴散或多輪交互假設）時，把要推翻的假設直接寫進這一趟的指令，不另外啟動角色。

第二趟由主對話自己對照完整 diff 走一次，聚焦 subagent 缺乏專案脈絡而判斷不了的部分：與既有慣例是否一致、跨檔案的語意衝突、本次改動與既有功能是否重複或互相覆蓋。

兩趟結果合併寫入 `## Reviewer result`：`- result:` 記 PASS 或 FAIL，`- findings:` 只列 blocker，每項附 path、symbol／hunk、可觸發情境、影響與最小修正方向；沒有 blocker 時 findings 記 none。

- Review 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task；不得為了避開 gate 而不加 flag。
- 回填後的 task 路徑即為唯一版本，後續複審與 knowledge 回寫都以它為準；差異只存在於審查當下，不留到下游。
- Review 有 blocker：主 agent 修正，重新執行相關驗證，再重跑上述兩趟。
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
2. 回填 `workflow_request` 選中角色的結果；coordinator／worker 或 legacy completion gate 另需 `diff_sha256` 與 `independence` 狀態，見 [elevated.md](elevated.md)。
3. Review 打回的歸因已在 §6b 每輪記錄。只有疑似 regression、同一問題反覆修正或使用者要求時，另由主對話做回歸歸因，結果寫入 `## Retrospective result`：查不到引入點就寫 `unknown` 並列出跑過的搜尋，framework change 需指名哪個檔案的哪一條規則要改成什麼。確認 regression 才執行 `retro.py --action Record`。
4. Standard task 在完成條件、驗證與 Review 都完成後即可更新 `status: done`；coordinator／worker 或 Elevated task 才執行 `~/.agent-workflow/runtime/agent_workflow.cmd close-task` 重跑完整 legacy gate（見 [elevated.md](elevated.md)）。工作停在半途用 `paused`，缺外部條件用 `blocked`。
5. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。
6. Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `knowledge --action Upsert --scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑；單次筆誤或單點邏輯錯誤不寫。

## 9. 平行編排

每次開始 code task 的開發前，主對話都要先做一次輕量拆分評估：確認是否存在至少兩個互不重疊、可獨立驗收、且各自需要不同檔案／模組範圍的子功能。明確不適合拆分時直接記為循序處理，不增加詢問與 orchestration 成本。

主對話在每個 code task 開始時自動完成拆分評估；若拆分規格符合資格，直接建立 worker worktree 並派發。具備 host-native agent collaboration 時優先使用它；只有要由 runtime 建立 detached worktree 並跨平台派發時才需要設定 dispatcher。worker 只做 implementation，不跑測試或角色；主對話整合並補齊全部完成條件後，才執行選定的 Review 與驗證。詳細 Git snapshot、平台 adapter 與失敗處理見 [orchestration.md](orchestration.md)。
