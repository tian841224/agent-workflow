---
name: workflow
description: 僅在實際修改 source code logic 或 test code logic 時使用；此時建立並維護 task.md，依序執行 Reviewer、Verifier。其他非程式碼邏輯任務 bypass workflow、不建立 task、不執行角色，由單一主對話處理。
---

# agent-workflow v4
Optional push-back skill applies only when a chosen design may violate conventions or add unnecessary complexity.

## 適用範圍

本 skill 只有在實際修改「目標專案」的 application source code logic 或 test code logic 時啟用。其他任務直接 bypass：不建立 task、不啟動角色，由主對話處理。既有或匯入的 `code_change: false` task 僅作相容性資料，不啟動角色。

### 流程層級

- Standard code task：`task → targeted validation → Reviewer → Verifier`。不強制 Project docs、fingerprint 或完整 execution-path 審查。
- Elevated code task：跨模組／契約／資料／權限變更、命中需要額外證據的 risk flag，或明確需要平行編排時，才加入 Project docs、Impact surface、freeze、完整 execution path、mutation check、browser 或 orchestration。
- Retrospective 只在疑似 regression、同一問題反覆修正或使用者要求時啟動，不因每個 `fix` 自動加入。

| 任務 | Task | 額外流程 | 角色 |
|---|---|---|---|
| non-code | 不建立 | 無 | 無 |
| Standard code | minimal task | targeted validation | Reviewer → Verifier |
| Elevated code | extended task | 依 risk flag 增加 gate | Reviewer → Adversarial（必要時）→ Verifier |
| coordinator／worker | extended task | orchestration、fingerprint、close gate | 依上列規則 |

## 1. 建立 Task

1. Standard task 直接沿用已知的 task context；只有需要跨 worktree、coordinator／worker 或 legacy runtime gate 時才執行 `scripts/project-resolver.py -Ensure`。
2. 若同一 worktree 已有一個 `in_progress` task，確認是續作；不是就先將舊 task 改為 `paused`、`blocked`、`done` 或 `superseded`。
3. 只有 Elevated task 預期會修改架構、契約或跨模組行為時，才執行 `~/.agent-workflow/runtime/scripts/project-doc.py -Action Lookup -Paths '<任務涉及的路徑>'`，讀過的路徑填進 task 的 `## Project docs`（見第 4 節、[project-docs.md](project-docs.md)）。
4. Standard task 依 `templates/task-minimal.md` 建立 `<YYYYMMDD-HHmmss>-<short-slug>/task.md`；Elevated、coordinator／worker 或需 legacy gate 的 task 依 `templates/task.md` 建立 extended task。
5. 明確填寫 `code_change: true | false`：只有修改「目標專案」application source code 或 test code 邏輯時為 `true`；除此之外（含設定／文件、script 修改與操作，或只執行測試、調查、code review）一律為 `false`。`code_change: true` 時同時填 `change_kind: fix | feature | refactor | chore`；是否回顧由 regression、重複修正或使用者要求決定。
6. 一律使用 `status: in_progress`。命中 freeze-required flag 時 `frozen_at` 先留空，取得使用者對目標、非目標與完成條件的確認後才填入；只有啟用進階 `impact-guard` 的 Elevated／編排流程才會機械攔截未凍結的 code 編輯。命中 `unclear_requirements` 時，先用 `planning` skill 釐清目標與限制，必要時加開 `grill-me` skill 壓力測試計畫（見 [risk-flags.md](risk-flags.md)）。

## 2. 記憶

1. 只有任務依賴歷史脈絡、使用者要求或已知回歸時，才以 2–5 個關鍵字執行 `~/.agent-workflow/runtime/scripts/knowledge.py -Action Search -Query '<keywords>' -Limit 5`；簡單、局部且不依賴歷史的修改略過。
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

Reviewer／Verifier 是否啟動只看 `code_change`；命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 任一時，才在 Reviewer 與 Verifier 之間加開 Adversarial。這些高風險檢查適用於所有 code task，不因 Standard／Elevated 名稱而被跳過。non-code task 永遠不進入本流程（non-code tasks do not enter this workflow）。

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

Standard code task 在 diff 完成後執行相關測試與必要的 `~/.agent-workflow/runtime/scripts/pre-review.py -RepoRoot <root>`；Elevated task 再依 risk flag 執行完整 deterministic checks。非程式碼任務不因本 skill 執行 pre-review。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：將命令與實際 checks 寫入 `Validation results`。
- 只有 coordinator／worker 或明確啟用 legacy completion gate 的 Elevated task 才記錄 `diff_sha256`；Standard task 以最後一次驗證與 Verifier 結果作為審查基準。
- `financial` 或 `data_write` 命中時另做一次 mutation check：把本次最關鍵的 1–2 個判斷人為改壞，確認守住它的測試真的變紅，再還原，於 `- mutation check:` 記 PASS 或 SKIP＋理由。測試全綠但斷言恆真、或 fixture 寫死成通過形狀，只有這一步抓得到。權威清單是 schema 的 `x_agent_workflow.mutation_check_required`。

## 6. Reviewer、Adversarial 複查與 Verifier

`code_change: true` 時，依序啟動原生 `agent-workflow-reviewer` 與 `agent-workflow-verifier`。命中六個高風險 flag 任一時，Reviewer PASS 後才加開原生 `agent-workflow-adversarial`（見 6a）。三者皆唯讀，方法論定義在各自角色檔案，本節只記錄觸發與回填規則。bug fix 或邏輯調整仍須依第 4 節 TDD 規則補測試。

Standard task 不需在每個角色前重算 fingerprint；主 agent 在送 Reviewer／Verifier 前應確認 diff 已穩定。只有 coordinator／worker 或明確啟用 legacy completion gate 的 Elevated task 才使用 `~/.agent-workflow/runtime/scripts/worktree-fingerprint.py`。

- Reviewer 指出未列入的呼叫端、入口或共用狀態時：先回填 `Impact surface` 與 `Execution path`，重新評估這些節點是否需要一併修改或補測試，再重評 `risk_flags`。確認影響跨出原範圍（例如另一功能走同一路徑）時補 `cross_feature`，並依 freeze 規則停手取得使用者確認，或 supersede 舊 task 另建新 task；不得為了避開 gate 而不加 flag。
- 回填後的 task 路徑即為唯一版本，Verifier、後續複審與 knowledge 回寫都以它為準；差異只存在於審查當下，不留到下游。
- Reviewer 有 blocker：主 agent 修正，重新執行相關驗證，再送複審。

### 6a. Adversarial 複查

Reviewer PASS、且 `risk_flags` 命中 `financial`／`data_write`／`migration`／`irreversible`／`schema`／`contract` 任一時觸發（權威清單是 schema 的 `x_agent_workflow.adversarial_required`），對象是 Reviewer 已判定 PASS 的同一份 diff。固定四項檢查：溯源（Provenance）、模式擴散（Pattern fan-out）、底層語意查證（Engine semantics）、迭代累積複查（Cross-round accumulation）；各自的方法論見角色檔案，本節不重述。

- 結論逐項寫進 `## Adversarial result`（`- Provenance: PASS` 等），gate 會逐項檢查且不接受 `N/A`。
- 有 blocker：主 agent 修正、重新驗證、回 Reviewer 重新確認 PASS，再送 Adversarial 複核。沒有 blocker 要明確回報「已嘗試推翻，未成立」，不得只寫「沒問題」。

Reviewer（與命中旗標時的 Adversarial）通過後才啟動 Verifier；探索範圍與方法論見角色檔案。
- Verifier 分類為實作缺陷、規格缺漏、測試缺口、環境阻塞（定義見角色檔案）：實作缺陷批次修正後重驗失敗與波及項。測試缺口：專案已有可用測試基礎設施且補測試落在本次範圍內時，比照實作缺陷退回補齊，重跑 pre-review 與相關驗證後重驗；缺少測試基礎設施、或需新增框架或重構才做得到時不擴張範圍，在 `Validation results` 記錄替代驗證、未覆蓋行為與原因，並依第 8 節寫入 knowledge。是否另開任務補齊由使用者決定，不得逕自結案或悄悄降低完成條件。
- 原生角色（Reviewer／Adversarial／Verifier）載入失敗，或在合理等待內沒有回報，一律先執行 installer `Repair` 再試一次；仍失敗就把 task 設為 `blocked` 並記錄下一步，不得由主 agent 代跑後結案，也不得把段落留空或寫 `SKIPPED` 直接結案。使用者明確決定要跳過角色時，以 `~/.agent-workflow/runtime/scripts/waive-roles.py -Reason '<使用者的理由>' -ConfirmedByUser` 寫入 `roles_waived`；主 agent 直接編輯 task 寫這個欄位會被 `impact-guard` 擋下。豁免只放寬三個角色段落，完成條件、pre-review、Impact surface、Project docs、mutation check 與已主動啟動的回顧仍照常。

Role polling that returns `timed_out` preserves `pending_init`/`running`; a continued no response triggers Repair, then marks the task `blocked` if it still fails.
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

大型 code task 拆成多個可獨立驗收的子功能、且各自需要不同檔案／模組範圍時，主對話改當 coordinator：只拆分、派工、受控套用與整合審查，不直接改 source。詳細拆分條件、狀態機、Git 邊界與已知限制見 [orchestration.md](orchestration.md)；v1 僅 Manual 模式，Claude／Codex／Antigravity 皆為 sequential fallback。
