---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: <true | false>
task_type: <fix | feature | refactor | chore | schema | migration | config | docs | investigation>
change_kind: <fix | feature | refactor | chore；code_change: true 時必填>
risk_flags: []
impact_scope: <file | module | multi_module | cross_project>
impact_effect: <none | local_behavior | shared_behavior | schema | data | contract | destructive>
impact_confidence: <high | medium | low>
workflow_request: auto
workflow_profile:
workflow_facts: <JSON object with evidence facts, or empty for conservative planning>
workflow_decision: <JSON decision record produced by workflow-plan>
created_at: <ISO-8601>
updated_at: <ISO-8601>
frozen_at:
independence: native
---

<!-- frontmatter 欄位補充說明：
frozen_at：freeze-required flag 命中時必填 ISO-8601。未填時 impact-guard 會擋下所有 code 編輯——
           先取得使用者對目標、非目標與完成條件的確認，再填入。
stop_reason：status 改為 paused 或 blocked 時必填（在等什麼、下一步是什麼）。
           未填時下次同一 worktree 的 Stop 會提示一次；放棄該任務改用 superseded。
roles_waived：使用者授權跳過 Reviewer／Adversarial／Verifier 的理由。
           只能由 waive-roles.py -Reason '<理由>' -ConfirmedByUser 寫入；
           直接編輯 task 寫這個欄位會被 impact-guard 擋下。
independence：coordinator／worker 或明確啟用 legacy completion gate 的 code task 才要求 native 或 degraded；Standard task 不因缺少此欄位而增加流程。
           預設 native（角色確實獨立執行）；原生角色無法載入或未回報、主 agent 因故自行填寫角色段落時
           如實改記 degraded——close gate 會拒絕 degraded 且未豁免的 task，解法是修好角色後改回 native，
           或由使用者以 roles_waived 明確豁免。`code_change: false` 的 task 不受此檢查。
-->

# <任務標題>

## Goal（目標）

<要完成或確認什麼>

## Scope（範圍）

<會修改／審查／驗證哪些行為；不處理哪些項目>

## Review round（審查輪次）

- round: 1
- prior findings: none
- fix delta: none
- impact delta: <direct callers and new affected nodes, or none>
- validation delta: <new focused validation, or none>
- unverified nodes: none

## Completion criteria（完成條件）

- [ ] 預期行為或審查目標完成
- [ ] 相關驗證通過

## Validation results（驗證結果）

- pre-review: <PASS | FAIL | SKIP>
- validation profile: <focused | affected | regression | full>
- changed paths: <repo-relative paths passed to validation, or none>
- command: <實際命令>
- checks: <執行項目與結果>
- skip reason: <只有 SKIP 時填寫>
- limitations: <未驗證限制；無則填 none>
- diff_sha256: <只在 coordinator／worker 或明確啟用 legacy completion gate 時填寫；一般 task 以最後一次驗證與角色結果為準>
- mutation check: <financial／data_write 時必填 PASS 或 SKIP：破壞關鍵判斷、確認守住它的測試變紅、再還原>
- mutation reason: <只有 mutation check 為 SKIP 時填寫>

<!-- 只有實際寫入記憶時加入：
## Knowledge result（記憶結果）

- updated: <entry-id>
-->

<!-- freeze-required task 再加入：
## Non-goals and compatibility（非目標與相容性要求）
## Current state and impact（現況與影響面）
## Decision and tradeoffs（方案、決策與取捨）
## Boundary and error paths（邊界及異常路徑）
## Acceptance cases（驗收案例）

| ID | 情境 | 預期結果 | 驗證方法 |
|---|---|---|---|

## User confirmation（使用者確認依據）
-->

<!-- Elevated code task 時加入（Project docs 的 read 與 Impact surface 需在動手改 code 前填寫）：
## Project docs（專案文件）
- read: <project-doc.py -Action Lookup 命中並讀過的 doc 路徑，逗號分隔；專案尚無文件時填 none - 理由>
- updated: <本次更新或確認過的 doc 路徑，逗號分隔；無則 none - 理由（change_kind: feature／refactor，或 risk_flags 命中 behavior_change／contract／schema／cross_feature 時，close-task.py 會檢查這一行）>

## Impact surface（影響面）
- 呼叫端：<反向搜尋命令與命中數；需要判斷的命中逐條 path:line>
- 觸發入口：<HTTP／cron／MQ／CLI／前端；無則 none>
- 共用狀態：<同 table／redis key／全域變數的其他流程；無則 none>
- 未確認節點：<追不完的節點與原因；無則 none>

## Execution path and regression evidence（執行路徑與回歸證據）
<入口 > 上游 > 修改點 > 下游終點；列出重要錯誤／重送／並發／異步分支與驗證證據>

## Reviewer result（Reviewer 結果；所有 code task 必填）
- result: <PASS | FAIL>
- diff_sha256: <Reviewer 實際審查的那份 diff 指紋；與現況不符時 gate 會要求重審>
- Architecture consistency: <PASS>
- Code quality and conventions: <PASS>
- Data consistency: <PASS | N/A - 理由>
- Security: <PASS | N/A - 理由>
- Risk and compatibility: <PASS>
- Performance: <PASS | N/A - 理由>
- Flow and impact completeness: <PASS>
- Failure modes and observability: <PASS>

## Adversarial result（Adversarial 複查結果；risk_flags 命中 financial／data_write／migration／irreversible／schema／contract 任一時才需要）
- result: <PASS 代表「已嘗試推翻，未成立」>
- diff_sha256: <Adversarial 實際複查的那份 diff 指紋>
- Provenance: <PASS>
- Pattern fan-out: <PASS>
- Engine semantics: <PASS>
- Cross-round accumulation: <PASS>

## Verifier result（Verifier 結果；所有 code task 必填）
- PASS
- diff_sha256: <Verifier 實際驗證的那份 diff 指紋>

## Retrospective result（回顧結果；只有疑似 regression、重複修正或使用者要求時加入）
- introduced_by: <引入缺陷的 commit sha，或 unknown - 跑過哪些搜尋>
- classification: <regression | pre_existing | external>
- miss_category: <只有 regression 時必填；八類見 schemas/retro.schema.json>
- gap_evidence: <只有 regression 時必填：哪份 task 的哪一段、或哪道 gate 沒攔下；附 task id 或 path:line>
- framework_change: <只有 regression 時必填：recorded:<retro-id>，或 not_needed - 理由>
- summary: <retrospective.md 回報的第六行，一行可獨立理解的摘要>
- occurrences: <只有 regression 時填：retro.py -Action Record 回傳的同類累積次數>
-->

<!-- 其他條件式段落：
behavior_change／ui：## Acceptance cases（驗收案例）
contract／schema／data_write／financial／migration：## Contract and data impact（契約與資料影響）
cross_feature／migration／irreversible：## Implementation sequence（實作順序、依賴與回滾點）
ui：## Browser verification（browser 畫面驗證）
change_kind: refactor：## Behavior invariants and before-after evidence（行為不變條件與前後證據）
-->

<!-- coordinator task 再加入（frontmatter 補 subtask_role: coordinator、integration_status: pending）：
## Decomposition plan（拆分計畫）
- 拆分理由與各 worker 範圍
- split plan JSON 路徑與 split-plan.py 的資格判定結果

## Worker results（worker 結果）
- 每個 worker 的狀態、驗證結果、fix-forward 歷程與 Manual handoff 資訊

## Delivery log（交付紀錄）
- 每份 patch、ownership／overlap findings、apply 結果
- 衝突合併：衝突路徑、合併取捨、詢問使用者的問題與答覆
- 待使用者裁決事項

## Integration verification（整合驗證）
- 整合後 pre-review、受影響測試集合、Reviewer 與 Verifier 證據
-->

<!-- worker task 再加入。frontmatter 補以下五欄（file_ownership 必須是 inline array）：
subtask_role: worker
parent_task_id: <coordinator-task-id>
base_commit: <40-hex；worktree baseline，同時是 Reviewer 的 diff 基準>
file_ownership: [src/payment/, tests/payment/]
delivery_status: pending

## Parent task（上層 task）
- coordinator task id 與 base_commit

## File ownership（檔案範圍）
- 與 frontmatter 的 file_ownership 一致的 repo-relative prefix 清單與理由
- 需要範圍外檔案時：ownership_request 與停止當下的證據
-->
