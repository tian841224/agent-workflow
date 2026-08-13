---
name: workflow
description: 實際修改 source code 邏輯、可執行 script 或 test code 時使用。建立並維護統一 task.md，依序執行 Reviewer、Verifier；純註解修改、設定與文件修改等非程式邏輯修改任務不使用 workflow、不建立 task、不執行角色，由單一主對話處理。
---

# agent-workflow v4

## 1. 建立 Task

0. 本 skill 僅適用於實際修改 source code 邏輯、可執行 script 或 test code 的任務；純註解修改、設定／文件修改、測試調查、除錯分析、code review、規劃、問答與翻譯等沒有動到程式邏輯的 non-code tasks bypass workflow，由單一主對話直接處理，不建立 task 或啟動角色。
1. 執行 `scripts/project-resolver.ps1 -Ensure` 取得 `project_id`、`worktree_id` 與 task 目錄。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作；不是就先將舊 task 改為 `paused`、`blocked`、`done` 或 `superseded`。
3. 預期會修改 code 時，先執行 `~/.agent-workflow/runtime/scripts/project-doc.ps1 -Action Lookup -Paths '<任務涉及的路徑>'`，讀完命中的文件再繼續；讀過的路徑之後要填進 task 的 `## Project docs`（見第 4 節、[project-docs.md](project-docs.md)）。
4. 依 `templates/task.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`。
5. 明確填寫 `code_change: true | false`：會修改 source code、可執行 script 或 test code 時為 `true`；只改設定／文件，或只執行測試、調查、code review 而未改 code 時為 `false`。`code_change: true` 時同時填 `change_kind: fix | feature | refactor | chore`；修 bug 或補漏洞是 `fix`，收尾會多一輪回顧（見第 8 節第 3 點）。
6. 一律使用 `status: in_progress`。命中 freeze-required flag 時 `frozen_at` 先留空，取得使用者對目標、非目標與完成條件的確認後才填入；未填之前 `impact-guard` 會擋下所有 code 編輯，等同凍結未完成就不能動工。命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標與限制，必要時加開 `grill-me` skill 壓力測試計畫（見 [risk-flags.md](risk-flags.md)）。

## 2. 記憶

1. 建立／續作 task 後，以任務的 2–5 個關鍵字執行 `~/.agent-workflow/runtime/scripts/knowledge.ps1 -Action Search -Query '<keywords>' -Limit 5`，只讀 global 與目前 project 的最相關 entry；明顯不依賴歷史脈絡的機械性修改可略過。
2. Query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文與整串連字號的命中率極低）。Search 只回傳 entry 第一行前 180 字，命中後要 Read `path` 全文。
3. Search 會一併列出各平台原生記憶（Codex `~/.codex/memories`、Claude 專案 `memory/`），標記 `scope: native`、`source: <平台>`、`status: needs_verification`，確保跨平台看到同一組記憶。原生記憶只讀不寫、不會被複製進 curated store；自動產生的 session 摘要預設排除，需要時加 `-IncludeSessionSummaries`，只要 curated 結果時加 `-ExcludeNative`。
4. 專案結構與模組流程不走 knowledge，改走 project docs（讀寫時機見第 1、4 節，分工與寫法見 [project-docs.md](project-docs.md)）。
5. Reviewer 與 Verifier 可自行執行 Search 建立脈絡。
6. `needs_verification` 或可能過時的記憶只能當線索，使用前回查目前程式、文件或設定。
7. 只有使用者糾正、可重用踩坑、重要方案決策、文件與實際行為不符或使用者明說要記住時，才以 `-Action Upsert -Scope Project` 寫入；沒有耐久價值時不增加任何步驟。
8. 同 topic 由 script 更新既有 native entry；相同內容自動去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `-ApprovedByUser`。
9. 有寫入時在 task 加 `Knowledge result` 記錄 entry id；沒有寫入時可完全省略。禁止寫入秘密、token、密碼、連線字串或個資。

## 3. Risk Flags

依實際風險判斷是否加入 `risk_flags`，不為湊流程加 flag。允許值、各值定義與對應要求見 [risk-flags.md](risk-flags.md)。

Reviewer／Verifier 是否啟動只看 `code_change`，與 `risk_flags` 無關，不會因為命中某個 flag 而額外觸發或跳過；命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 任一時，額外在 Reviewer 與 Verifier 之間加開 Adversarial 複查（見第 6 節第 6a 小節），這是唯一一個由 `risk_flags` 控制是否啟動的角色。non-code tasks do not enter this workflow regardless of risk_flags（實際啟動機制見第 6 節）。既有或匯入的 `code_change: false` task 僅作相容性資料，不啟動角色。

## 4. 實作

- 讀相關程式前先跑 `~/.agent-workflow/runtime/scripts/project-doc.ps1 -Action Lookup -Paths '<預計改動的 repo 相對路徑>'`，先讀命中的模組文件與 `docs/architecture.md`／`docs/dataflow.md` 再讀 code；`stale: true` 只當線索，一律以現況程式為準。文件不存在時本次先補上，範圍限本次能從實際程式確認的部分，不臆測。讀過的路徑填進 task 的 `## Project docs` 的 `read:`；此段未填、含 `<placeholder>` 或路徑不存在時 `impact-guard` 會擋下所有 code 編輯，專案尚無文件時填 `none - <理由>`。
- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍。
- 讀完相關程式後、動手改第一行 code 前，先填 task 的 `Impact surface`：對每個要改的 symbol、路由與事件名做反向搜尋，記錄搜尋命令與命中數，需要判斷的命中逐條附 `path:line`；列出實際觸發入口（HTTP／cron／MQ／CLI／前端）、共用狀態（同 table、同 redis key、同全域變數的其他流程），以及追不完而未確認的節點。此段未填時 `impact-guard` 會擋下所有 code 編輯；需先診斷才知道改哪裡的 bug 任務，診斷本身只需讀取與執行、不受影響，確定修改點後立即補填。
- 修改程式後先建立 execution path：從實際入口往下追到修改點，再追到所有重要終點；同時確認修改點的上游前置條件、下游契約，以及錯誤、重送、並發與異步分支。不可只看修改點到下一個呼叫點。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- Bug 先重現或取得足以確認根因的證據；修改後執行相關驗證，無法自動化時在 task 記錄替代驗證與原因。
- 遵循 TDD：先寫會失敗的測試涵蓋預期行為，再實作最小修改使其通過，最後視需要重構；以專案既有檢查與 pre-review 驗證。無法自動化測試時在 task 記錄替代驗證與原因，不得省略。
- 選最簡完整解法，沿用既有依賴與風格；不順手整理、抽象或擴張範圍。
- 發現新 hard-risk flag 時先更新 task；若需凍結則停手取得使用者確認。
- `change_kind: feature｜refactor`，或 `risk_flags` 命中 `behavior_change`／`contract`／`schema`／`cross_feature` 時，在跑 pre-review 之前更新受影響文件（原料是 `Impact surface` 與 `Execution path`，見 [project-docs.md](project-docs.md) 的搬運對照）；其餘情況只在 Lookup 回報 `stale: true` 時確認內容仍正確。填 task 的 `## Project docs` 的 `updated:`：列出更新的路徑，或 `none - <理由>`；上述條件命中時 `close-task.ps1` 會檢查這一行，未填、含 `<placeholder>` 或路徑不存在一律擋下結案。

## 5. Pre-review

程式碼或設定 diff 完成後，執行 managed runtime 的 `~/.agent-workflow/runtime/scripts/pre-review.ps1 -RepoRoot <root>`。Go 執行 changed-file gofmt、vet、build、test 與可用的 golangci-lint；Node 執行既有 lint、typecheck、build、test scripts；其他技術棧可用 `.pre-review-extra.ps1`。預設只保留 PASS／FAIL／SKIP 摘要，FAIL 的完整輸出寫入暫存 log。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。
- `code_change: true` 時同時記錄 `- diff_sha256:`，值取自 `~/.agent-workflow/runtime/scripts/worktree-fingerprint.ps1 -Path <repo>`（worker task 加 `-Base <base_commit>`）。收尾時會重算比對，之後又動到 code 就得重跑 pre-review。
- `financial` 或 `data_write` 命中時另做一次 mutation check：把本次最關鍵的 1–2 個判斷人為改壞，確認守住它的測試真的變紅，再還原，於 `- mutation check:` 記 PASS 或 SKIP＋理由。測試全綠但斷言恆真、或 fixture 寫死成通過形狀，只有這一步抓得到。權威清單是 schema 的 `x_agent_workflow.mutation_check_required`。

## 6. Reviewer、Adversarial 複查與 Verifier

`code_change: true` 時，依序啟動原生 `agent-workflow-reviewer`；`risk_flags` 命中第 3 節列的六個旗標任一時，Reviewer PASS 後加開原生 `agent-workflow-adversarial`（見 6a）；最後啟動原生 `agent-workflow-verifier`。三者皆唯讀，輸入只帶 task、diff、必要專案規則與驗證證據。`code_change: false` 跳過全部角色。

啟動每個角色前先跑一次 `worktree-fingerprint.ps1`，把值連同 diff 交給它，回報後原樣寫進該角色段落的 `- diff_sha256:`。收尾 gate 會重算比對：角色簽核之後又改了 code，指紋就對不上，該角色必須重跑。這是「修正引入新回歸」唯一的機械防線——實際發生過連續五輪修正，每一輪都推翻上一輪。

- Reviewer 先核對 correctness，再回報 architecture consistency、code quality and conventions、data consistency、security、risk and compatibility、performance、flow and impact completeness、failure modes and observability；data consistency、security、performance 不適用時標 `N/A` 與理由，其餘六項每次必查。
- Reviewer 必須沿 execution path 審查：確認入口如何到達修改點、上游傳入的前置條件與狀態、修改點的行為、下游每一段的輸入／輸出契約與最終效果。以 `A > B > C > D` 為例，修改 `C` 時必須審查並驗證 `A > B > C > D`，不能只審查 `C > D`；重要錯誤、重送、並發、異步與替代分支也要納入回歸範圍，並在 task 留下 path 與證據。
- Reviewer 必須自行反向搜尋重建 execution path，不得沿用 task 敘述；順序是先重建、後對照，不得先讀 task 的路徑再去驗證它。回報要列出與 task 的差異，無差異時明寫。
- Reviewer 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task；不得為了避開 gate 而不加 flag。
- 回填後的 task 路徑即為唯一版本，Verifier、後續複審與 knowledge 回寫都以它為準；差異只存在於審查當下，不留到下游。
- Reviewer 有 blocker：主 agent 修正，重新執行相關驗證，再送複審。

### 6a. Adversarial 複查

Reviewer PASS、且 `risk_flags` 命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 任一時觸發（權威清單是 schema 的 `x_agent_workflow.adversarial_required`），對象是 Reviewer 已判定 PASS 的同一份 diff。這六個旗標的共通點是「巧合正確或假設錯誤的代價高」，Reviewer 的確認式審查不足以攔下這類問題，需要一個心態相反、專找漏洞的獨立角色。心態與 Reviewer 相反：不是確認正確，而是預設有一處假設是錯的、找證據推翻它，找不到才算過；不重跑 Reviewer 已完成的 execution path／八面向確認。

- 溯源（Provenance）：新增或修改的每個判斷依據（時間戳、狀態、餘額基準、旗標…）實際代表的意義，是否等於它被賦值的時機／來源；只要有一個具體情境會讓兩者不一致就是 blocker。
- 模式擴散（Pattern fan-out）：(a) 新增的守門邏輯，同模組／同 entity 是否已有類似邏輯而未比照；(b) 這次修掉的缺陷是否以同一形態存在於其他位置（重複檔案、同類 entity、同一種呼叫慣例）。兩邊都要附反向搜尋命令與命中數，沒搜尋不得宣稱無擴散。
- 底層語意查證（Engine semantics）：依賴特定資料庫／並發原語行為時，要求可查證的官方依據；只有「測試輸出一致」不能結案，查無依據要明確標示為未查證風險，不得默許通過。
- 迭代累積複查（Cross-round accumulation）：查最近幾輪同一批檔案的異動歷史，確認跨輪疊加沒有引入單輪 diff 看不出來的問題、前幾輪的保護沒有在這輪被拿掉；連續三輪以上都在修同一區塊時明寫輪次並把「重新檢視前提」當選項交給使用者。沒有多輪歷史則略過並註明。
- 四項結論逐項寫進 `## Adversarial result`（`- Provenance: PASS` 等），gate 會逐項檢查且不接受 `N/A`。
- 有 blocker：主 agent 修正、重新驗證、回 Reviewer 重新確認 PASS，再送 Adversarial 複核。沒有 blocker 要明確回報「已嘗試推翻，未成立」，不得只寫「沒問題」。

Reviewer（與命中旗標時的 Adversarial）通過後，Verifier 從實際入口執行完整 path，逐條執行完成條件，補一次最可能找到 bug 的針對性探索；不得以只測修改函式或只測 `C > D` 代替整體流程；`ui` 使用 browser。
- Verifier 將問題分為實作缺陷、規格缺漏、測試缺口、環境阻塞；實作缺陷批次修正後重驗失敗與波及項。測試缺口：專案已有可用測試基礎設施且補測試落在本次範圍內時，比照實作缺陷退回補齊，重跑 pre-review 與相關驗證後重驗；缺少測試基礎設施、或需新增框架或重構才做得到時不擴張範圍，在 `Validation results` 記錄替代驗證、未覆蓋行為與原因，並依第 8 節寫入 knowledge。是否另開任務補齊由使用者決定，不得逕自結案或悄悄降低完成條件。
- 原生角色（Reviewer／Adversarial／Verifier）載入失敗，或在合理等待內沒有回報，一律先執行 installer `Repair` 再試一次；仍失敗就把 task 設為 `blocked` 並記錄下一步，不得由主 agent 代跑後結案，也不得把段落留空或寫 `SKIPPED` 直接結案。使用者明確決定要跳過角色時，以 `~/.agent-workflow/runtime/scripts/waive-roles.ps1 -Reason '<使用者的理由>' -ConfirmedByUser` 寫入 `roles_waived`；主 agent 直接編輯 task 寫這個欄位會被 `impact-guard` 擋下。豁免只放寬三個角色段落，完成條件、pre-review、Impact surface、Project docs、mutation check 與回顧一律照常。

## 7. 失敗與續作

- 同一修復假說失敗兩次，不再猜第三次；回到證據與根因重新診斷。
- Reviewer／Verifier 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `paused`；缺權限、環境或外部決策用 `blocked`。兩者都必須在 frontmatter 填 `stop_reason:`（在等什麼、下一步是什麼），未填時 Stop hook 會擋下結束回合；確定不做了用 `superseded`。
- 不維護額外 state service；task.md 是唯一任務狀態。

## 8. 完成

1. 對照 task 完成條件，填入 pre-review、其他實際指令、結果與未驗證限制。
2. 回填 Reviewer／Adversarial（命中旗標時）／Verifier 結果與各自的 `diff_sha256`，以及 `independence` 狀態（若適用）。
3. `change_kind: fix` 且 `code_change: true` 時（worker 除外，由 coordinator 對整體做一次），啟動原生 `agent-workflow-retrospective`：它獨立判定這個缺陷是不是先前的修改引入的，是的話歸因到框架的哪一道 gate 沒攔下。把它回報的六行原樣填進 `## Retrospective result`。判定為 `regression` 時，執行 `~/.agent-workflow/runtime/scripts/retro.ps1 -Action Record -ProposedChange '<它提出的具體改法>'`，把回傳的 id 填成 `framework_change: recorded:<id>`、`occurrences` 填回傳值；`not_needed` 時要寫理由。回傳 `escalate: true` 代表同一 `miss_category` 已達門檻，在完成回報明確寫「這是第 N 次 `<miss_category>`，建議改 `<檔案>` 的 `<規則>`」交使用者決定——**不自行修改 agent-workflow**（跨 repo，且屬硬護欄的範圍外改動）；目前工作目錄就是 agent-workflow 本身時，取得使用者同意後才可直接套用。
4. 結案一律執行 `~/.agent-workflow/runtime/scripts/close-task.ps1`，由它重跑完整 gate 後才寫入 `done`；不得直接編輯 task 的 `status` 欄位改成 `done`（`impact-guard` 會擋）。工作停在半途用 `paused`，缺外部條件用 `blocked`。
5. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。
6. Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `-Action Upsert -Scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑；單次筆誤或單點邏輯錯誤不寫。

## 9. 平行編排

大型 code task 拆成多個可獨立驗收的子功能、且各自需要不同檔案／模組範圍時，主對話改當 coordinator：只拆分、派工、受控套用與整合審查，不直接改 source。詳細拆分條件、狀態機、Git 邊界與已知限制見 [orchestration.md](orchestration.md)；v1 僅 Manual 模式，Claude／Codex／Antigravity 皆為 sequential fallback。
