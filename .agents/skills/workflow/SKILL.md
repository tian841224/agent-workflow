---
name: workflow
description: 僅在實際修改 source code logic 或 test code logic 時使用；此時建立並維護 task.md，由 workflow planner 依影響程度組合出該跑的 capability 與角色。其他非程式碼邏輯任務 bypass workflow、不建立 task、不執行角色，由單一主對話處理。
---

# agent-workflow v4
Optional push-back skill applies only when a chosen design may violate conventions or add unnecessary complexity.

## 適用範圍

本 skill 只有在實際修改「目標專案」的 application source code logic 或 test code logic 時啟用。其他任務直接 bypass：不建立 task、不啟動角色，由主對話處理。既有或匯入的 `code_change: false` task 僅作相容性資料，不啟動角色。

### Workflow Planner 與流程層級

Workflow 沒有固定 pipeline，也沒有預設檔位。`schemas/workflow-policy.json` 的 capability planner 依任務類型、複雜度與影響程度，**逐一**組合出這次要跑的流程。

**外層選取（跑哪些 capability）**：task type、`change_kind`、`risk_flags`、`impact_scope`、`impact_effect` 產生候選；每個 capability 各自綁自己關心的事實判斷 selected／suppressed／unknown，彼此不連動。任何組合都合法——只跑 `verifier`、`adversarial` + `verifier` 而沒有 `reviewer`、只跑 evidence capability 而沒有角色、或一個都不跑，都是正常結果。

**內層選取（跑該 capability 的哪些 step）**：selected 之後，policy 內每個 step 的 `when` 再依同一組向度決定要不要跑。同一個 `execution_path_review` 在 `impact_scope: file` 只有 EP1、EP4，在 `cross_project` 才展開 EP1–EP5。

九個 capability：`schema_compatibility`、`migration_safety`、`data_impact`、`contract_review`、`execution_path_review`、`regression_validation`（`kind: evidence`，產出寫在各自 section 的 `- <step id>:` 行）與 `reviewer`、`adversarial`、`verifier`（`kind: role`，啟動對應原生角色）。`order_after` 只決定順序，不會把缺席的前置補回來。

**證據方向是單向的**：`workflow_facts` 與 impact 欄位由 agent 宣告，只能讓流程變多；要抑制任何 capability，必須由 planner 從 worktree 實際採到的 observed evidence 證明。採不到證據就是 `unknown`，`unknown` 一律保留、不得當成沒有影響。同一條規則也適用 risk flag：宣告的 flag 只有在它代表的 capability 全部被 observed evidence 抑制時才會解除額外 gate。

**採證來源**：planner 從 `git diff` 的 hunk context 取出這次改動到的 symbol，再用 `git grep` 查它們在**程式碼檔**（文件提到函式名不算呼叫端）中的引用位置，得出 `symbol_reach`：`none`（只有自己的檔案用）、`module`（同目錄）、`multi_module`（跨目錄）。DDL 另走欄位名採證，兩者的 `has_consumer` 取聯集——任一找到就是有，要證明沒有則兩者都得證明。

**呼叫端搜尋看不到資料層耦合**：一個沒有任何外部呼叫端的函式，仍可能寫入被別處讀取的 DB 欄位、Redis key、全域變數或訊息佇列。因此 planner 另外掃描 diff 的新增行，偵測 SQL DML、ORM 寫入、Redis／快取寫入、`sync`／`atomic` 共用狀態、檔案寫入與訊息發送，得出 `shared_state_write`。只要偵測到任一訊號，就一律視為有共用狀態耦合，不得放寬任何檢查。

`symbol_reach` 只會**提高** effective `impact_scope`，不會降低：agent 宣告 `file` 但實際有跨目錄呼叫端時，`execution_path_review` 會自動被選中並展開 EP2／EP5。這是防止低估影響的機制。反之，抽不出 symbol、symbol 數超過 50、或集合裡含有 `run`／`main` 這類過短或通用的名字時，「找到呼叫端」仍然可信（升級照做），但**不得**據此宣稱沒有呼叫端——此時 `symbol_reach` 為 `unknown`。

Evidence capability 只在影響確實擴散時才登場，一般 code change 的成本與舊制 Standard 相同：

| 情境 | 典型組合 | evidence step 數 |
|---|---|---|
| 單檔 bug fix、模組內小功能 | `reviewer` → `verifier` | 0 |
| 實證無 consumer 的 additive 欄位 | 無 capability（僅 baseline diff 檢查）＋ `Impact surface` 說明抑制依據 | 0 |
| 邏輯單純但需實測（實證無呼叫端） | `verifier` | 0 |
| 跨模組 refactor | `execution_path_review` → `regression_validation` → `reviewer` → `verifier` | 10 |
| 金流狀態機 | `data_impact` → `execution_path_review` → `regression_validation` → `reviewer` → `adversarial` → `verifier` | 14 |
| 大表 migration + backfill | `execution_path_review` → `schema_compatibility` → `data_impact` → `migration_safety` → `reviewer` → `adversarial` → `verifier` | 20 |
| coordinator／worker | 依上列規則，另加 orchestration、fingerprint 與 close gate | 依上列規則 |

`workflow_request` 是使用者指定的 capability 下限清單（例如 `[verifier]`），planner 不得抑制它們。`workflow_profile` 只是由組合推導出來的顯示標籤，不決定任何檢查。

`workflow_planner.py` 是新 task 的流程分流入口；`task_profile.py` 保留 legacy API 與舊 task 的保守 fallback（沒有 `workflow_decision` 的舊 task 仍走既有 `code_change` 與高風險旗標規則）。Retrospective 只在疑似 regression、同一問題反覆修正或使用者要求時啟動，不因每個 `fix` 自動加入。

## 1. 建立 Task

1. Standard task 直接沿用已知的 task context；只有需要跨 worktree、coordinator／worker 或 legacy runtime gate 時才執行 `scripts/project-resolver.py -Ensure`。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作；不是就先將舊 task 改為 `paused`、`blocked`、`done` 或 `superseded`。
3. 只有 Elevated task 預期會修改架構、契約或跨模組行為時，才執行 `~/.agent-workflow/runtime/scripts/project-doc.py -Action Lookup -Paths '<任務涉及的路徑>'`，讀過的路徑填進 task 的 `## Project docs`（見第 4 節、[project-docs.md](project-docs.md)）。
4. Standard task 依 `templates/task-minimal.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`；Elevated、coordinator／worker 或需 legacy gate 的 task 依 `templates/task.md` 建立 extended task。
5. 明確填寫 `code_change: true | false`：只有修改「目標專案」application source code 或 test code 邏輯時為 `true`；除此之外（含設定／文件、script 修改與操作，或只執行測試、調查、code review）一律為 `false`。Code task 另填 `task_type`、impact fields，需要指定流程下限時才填 `workflow_request`（capability 清單）；Planner 產生 `workflow_profile` 與 `workflow_decision`。`change_kind: fix | feature | refactor | chore` 仍在 `code_change: true` 結案時必填。
6. 一律使用 `status: in_progress`。命中 freeze-required flag 時 `frozen_at` 先留空，取得使用者對目標、非目標與完成條件的確認後才填入；只有啟用進階 `impact-guard` 的 Elevated／編排流程才會機械攔截未凍結的 code 編輯。命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標與限制，必要時加開 `grill-me` skill 壓力測試計畫（見 [risk-flags.md](risk-flags.md)）。

## 2. 記憶

1. 只有任務依賴歷史脈絡、使用者要求或已知回歸時，才以 2–5 個關鍵字執行 `~/.agent-workflow/runtime/scripts/knowledge.py -Action Search -Query '<keywords>' -Limit 5`；簡單、局部且不依賴歷史的修改略過。
2. Query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文與整串連字號的命中率極低）。Search 只回傳 entry 第一行前 180 字，命中後要 Read `path` 全文。
3. 每次 session 啟動時，三平台 managed `SessionStart` hook 會自動執行 `memory-context`，讀取共用 curated store 與可讀的原生 Markdown／text 記憶並注入 reference context。原生記憶只讀不寫，標記 `needs_verification`，不會被複製進 curated store；session summaries、instruction-only files、credential-like content 與 Antigravity `.pb` 檔案預設排除。完整內容仍可用 Search 回查 `path`。
4. 專案結構與模組流程不走 knowledge，改走 project docs（讀寫時機見第 1、4 節，分工與寫法見 [project-docs.md](project-docs.md)）。
5. Reviewer 與 Verifier 可自行執行 Search 建立脈絡。
6. `needs_verification` 或可能過時的記憶只能當線索，使用前回查目前程式、文件或設定。
7. 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 `agent_workflow learn --action Capture` 寫入目前 project；跨專案偏好或通用教訓才寫入 Global。沒有耐久價值時不增加任何步驟。
8. 同 topic 由 script 更新既有 native entry；相同內容自動去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `-ApprovedByUser`。
9. 有寫入時在回覆中簡短告知摘要；禁止寫入秘密、token、密碼、連線字串或個資。`learn` 會依 content hash 去重。

## 3. Risk Flags

依實際風險判斷是否加入 `risk_flags`，不為湊流程加 flag。允許值、各值定義與對應要求見 [risk-flags.md](risk-flags.md)。

新 task 的 Reviewer／Adversarial／Verifier 是否啟動，逐一只看 Planner 的 selected capabilities；三者互相獨立，任何子集合都是合法組合。舊 task 沒有 Planner decision 時才依 `code_change` 與既有高風險旗標 fallback。所有 suppress 必須有 reason/evidence，unknown 必須保留。non-code task 永遠不進入本流程。

## 4. 實作

- Elevated task 讀相關程式前才跑 `~/.agent-workflow/runtime/scripts/project-doc.py -Action Lookup -Paths '<預計改動的 repo 相對路徑>'`，先讀命中的模組文件再讀 code；`stale: true` 只當線索，一律以現況程式為準。Standard task 只需讀專案 instructions、相關程式、呼叫端與既有測試；若發現架構或影響面不明，再升級為 Elevated task。
- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍。
- Elevated task 讀完相關程式後、動手改第一行 code 前，先填 task 的 `Impact surface`：對每個要改的 symbol、路由與事件名做反向搜尋，記錄搜尋命令與命中數，需要判斷的命中逐條附 `path:line`；列出實際觸發入口、共用狀態與未確認節點。
- Standard task 只需建立與修改點直接相關的 execution path；Elevated task 才要求從實際入口追到所有重要終點，並涵蓋錯誤、重送、並發與異步分支。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- Bug 先重現或取得足以確認根因的證據；修改後執行相關驗證，無法自動化時在 task 記錄替代驗證與原因。
- 有新增或修正可測試行為、或屬於 bug fix／邏輯調整時遵循 TDD：先寫一個在修復前會真正失敗的測試，證明它有正確捕捉到這次的錯誤；再實作最小修改使其通過，變綠即代表這個測試往後能擋住同一個錯誤再次發生。純測試重整或無法自動化時記錄替代驗證與原因。所有 code task 仍須執行相關驗證。
- 選最簡完整解法，沿用既有依賴與風格；不順手整理、抽象或擴張範圍。
- 發現新 hard-risk flag 時先更新 task；若需凍結則停手取得使用者確認。
- `change_kind: feature｜refactor`，或 `risk_flags` 命中 `behavior_change`／`contract`／`schema`／`cross_feature` 時，在跑 pre-review 之前處理受影響文件（原料是 `Impact surface` 與 `Execution path`，見 [project-docs.md](project-docs.md) 的搬運對照）：涵蓋這次改動的文件**不存在時建立**；已存在且內容仍準確時不必重寫，只需確認；內容不準確時才更新。不是每次都要重寫既有文件，也不是無關的文件都要生一份。其餘情況只在 Lookup 回報 `stale: true` 時確認內容仍正確。填 task 的 `## Project docs` 的 `updated:`：列出建立或更新的路徑，或 `none - <理由>`（例如「已存在且準確」）；上述條件命中時 `close-task.py` 會檢查這一行，未填、含 `<placeholder>` 或路徑不存在一律擋下結案。

## 5. Pre-review

Standard code task 在 diff 完成後執行相關測試與必要的 `~/.agent-workflow/runtime/scripts/pre-review.py -RepoRoot <root>`；Elevated task 再依 risk flag 執行完整 deterministic checks。需要時可傳入 `-Profile focused|affected|regression|full -Path <repo-relative-path>`，runtime 會以 `AGENT_WORKFLOW_VALIDATION_PROFILE` 與 `AGENT_WORKFLOW_CHANGED_PATHS` 傳給 repo extra；未支援這些環境變數的 repo 維持既有命令。非程式碼任務不因本 skill 執行 pre-review。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。
- 只有 coordinator／worker 或明確啟用 legacy completion gate 的 Elevated task 才記錄 `diff_sha256`；Standard task 以最後一次驗證與 Verifier 結果作為審查基準。
- `financial` 或 `data_write` 命中時另做一次 mutation check：把本次最關鍵的 1–2 個判斷人為改壞，確認守住它的測試真的變紅，再還原，於 `- mutation check:` 記 PASS 或 SKIP＋理由。測試全綠但斷言恆真、或 fixture 寫死成通過形狀，只有這一步抓得到。權威清單是 schema 的 `x_agent_workflow.mutation_check_required`。

## 6. Reviewer、Adversarial 複查與 Verifier

新 task 依 Planner selected capabilities 啟動原生 `agent-workflow-reviewer`、`agent-workflow-adversarial` 與 `agent-workflow-verifier`；沒有 Planner decision 的舊 task 才依 `code_change` 與既有高風險 flag fallback。三者皆唯讀，方法論定義在各自角色檔案，本節只記錄觸發與回填規則。bug fix 或邏輯調整仍須依第 4 節 TDD 規則補測試。

**Reviewer 面向的條件式放寬**：Planner 在 `workflow_decision` 的 reviewer 紀錄裡填 `waived_dimensions`。目前只有一條規則——effective scope 不超過 `module`、`symbol_reach: none`、`has_consumer: false`、`public_api_change: false`、`shared_state_write: false`、`data_transform: false`、`destructive_operation: false` 全部由 observed evidence 成立時，`Architecture consistency` 可回 `N/A - <理由>`（**必須附理由**，gate 不接受單獨的 `N/A`）。

`Flow and impact completeness`、`Code quality and conventions`、`Risk and compatibility`、`Failure modes and observability` 永遠不放寬：影響完整性正是用來抓呼叫端搜尋看不到的資料層耦合，而程式碼品質與正確性和影響範圍無關——「沒有人呼叫它」不代表「它寫得對」。

Standard task 不需在每個角色前重算 fingerprint；主 agent 在送 Reviewer／Verifier 前應確認 diff 已穩定。只有 coordinator／worker 或明確啟用 legacy completion gate 的 Elevated task 才使用 `~/.agent-workflow/runtime/scripts/worktree-fingerprint.py`。

- Reviewer 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task；不得為了避開 gate 而不加 flag。
- 回填後的 task 路徑即為唯一版本，Verifier、後續複審與 knowledge 回寫都以它為準；差異只存在於審查當下，不留到下游。
- Reviewer 有 blocker：主 agent 修正，重新執行相關驗證，再送複審。

### 6a. Adversarial 複查

Planner selected `adversarial` 時觸發；沒有 Planner decision 的舊 task，仍以 `risk_flags` 命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 作為 fallback。同一份 diff 上若 `reviewer` 也被 selected，Adversarial 排在 Reviewer PASS 之後；`reviewer` 未被 selected 時 Adversarial 直接針對實作與資料語意推翻假設，不預設已有 Reviewer 結論。固定四項檢查保持不變。

- 結論逐項寫進 `## Adversarial result`（`- Provenance: PASS` 等），gate 會逐項檢查且不接受 `N/A`。
- 有 blocker：主 agent 修正、重新驗證；`reviewer` 也在組合內時回 Reviewer 重新確認 PASS，再送 Adversarial 複核。沒有 blocker 時角色只回報單行 `PASS`；有 blocker 時只列 blocker。

Verifier 排在組合中其他角色之後；`reviewer`／`adversarial` 未被 selected 時 Verifier 可直接啟動。探索範圍與方法論見角色檔案。
- Verifier 分類為實作缺陷、規格缺漏、測試缺口、環境阻塞（定義見角色檔案）：實作缺陷批次修正後重驗失敗與波及項。測試缺口：專案已有可用測試基礎設施且補測試落在本次範圍內時，比照實作缺陷退回補齊，重跑 pre-review 與相關驗證後重驗；缺少測試基礎設施、或需新增框架或重構才做得到時不擴張範圍，在 `Validation results` 記錄替代驗證、未覆蓋行為與原因，並依第 8 節寫入 knowledge。是否另開任務補齊由使用者決定，不得逕自結案或悄悄降低完成條件。
- 原生角色（Reviewer／Adversarial／Verifier）載入失敗，或在合理等待內沒有回報，一律先執行 installer `Repair` 再試一次；仍失敗就把 task 設為 `blocked` 並記錄下一步，不得由主 agent 代跑後結案，也不得把段落留空或寫 `SKIPPED` 直接結案。使用者明確決定要跳過角色時，以 `~/.agent-workflow/runtime/scripts/waive-roles.py -Reason '<使用者的理由>' -ConfirmedByUser` 寫入 `roles_waived`；主 agent 直接編輯 task 寫這個欄位會被 `impact-guard` 擋下。豁免只放寬三個角色段落，完成條件、pre-review、Impact surface、Project docs、mutation check 與已主動啟動的回顧仍照常。

Role polling that returns `timed_out` preserves `pending_init`/`running`; a continued no response triggers Repair, then marks the task `blocked` if it still fails.

### 6b. Review round 與增量錨定

第一輪依角色檔案建立獨立脈絡。Reviewer blocker 或 Verifier 實作缺陷修正後，後續輪次在 task.md 的 `## Review round` 記錄前一輪 finding、本輪 fix delta、impact delta、重新執行的驗證與未確認節點；角色可用它導航，但仍須自行核對 diff，不得把 task 敘述當成正確性證據。

後續輪次採 delta-first：先檢查修復項、直接呼叫端與本輪新增波及項，不重複輸出未變更內容。若修改入口、公開介面、共用狀態、資料／契約、並發／非同步／錯誤邊界，或前輪存在未確認節點，則重新展開完整 execution path。Diff anchor 使用 repo-relative path、symbol 與 diff hunk，不得只依賴行號。

角色對話回報只保留錯誤：有 finding、blocker、FAIL、BLOCKED 或未驗證限制時，輸出具體錯誤、依據、影響與可重現位置，省略所有 PASS 項目；全部通過時只輸出單行 `PASS`。Verifier 可使用 Docker／SQL，但只能操作 `aw-verifier-*` 一次性資源；`docker run` 必須 `--rm`，不得掛載既有資料或修改既有 container／database／volume，SQL 寫入只限一次性 container，完成後必須清除並確認無殘留。不得以固定 token 截斷輸出。Task 內仍依 schema 回填必要的機械檢查欄位。
## 7. 失敗與續作

- 同一修復假說失敗兩次，不再猜第三次；回到證據與根因重新診斷。
- Reviewer／Verifier 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `paused`；缺權限、環境或外部決策用 `blocked`。兩者都必須在 frontmatter 填 `stop_reason:`（在等什麼、下一步是什麼）；沒填時下次同一 worktree 的 Stop 會提示一次（同一 session 只提示一次），提醒補上，不阻斷結束回合。確定不做了用 `superseded`。
- 不維護額外 state service；task.md 是唯一任務狀態。

## 8. 完成

1. 對照 task 完成條件，填入 pre-review、其他實際指令、結果與未驗證限制。
2. 回填 Reviewer／Adversarial（命中旗標時）／Verifier 結果與各自的 `diff_sha256`，以及 `independence` 狀態（若適用）。
3. 只有疑似 regression、同一問題反覆修正或使用者要求時，才啟動原生 `agent-workflow-retrospective`；結果寫入 `## Retrospective result`，確認 regression 才執行 `retro.py -Action Record` 記錄 framework change。
4. Standard task 在完成條件、驗證、Reviewer 與 Verifier 都完成後即可更新 `status: done`；coordinator／worker 或 Elevated task 才執行 `~/.agent-workflow/runtime/scripts/close-task.py` 重跑完整 legacy gate。工作停在半途用 `paused`，缺外部條件用 `blocked`。
5. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。
6. Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `-Action Upsert -Scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑；單次筆誤或單點邏輯錯誤不寫。

## 9. 平行編排

每次開始 code task 的開發前，主對話都要先做一次輕量拆分評估：確認是否存在至少兩個互不重疊、可獨立驗收、且各自需要不同檔案／模組範圍的子功能。明確不適合拆分時直接記為循序處理，不增加詢問與 orchestration 成本。

若評估結果適合拆分，先向使用者說明候選 worker、ownership、依賴與預期收益，詢問是否要平行處理；在使用者確認前不得建立 coordinator／worker、detached worktree 或執行 `orchestrate.py -Action Init`。使用者拒絕或未確認時，退回單一 agent 循序處理。使用者確認後，主對話改當 coordinator，只負責拆分、派工、受控套用與整合審查，不直接改 source。詳細拆分條件、狀態機、Git 邊界與已知限制見 [orchestration.md](orchestration.md)；v1 僅 Manual 模式，Claude／Codex／Antigravity 皆為 sequential fallback。
