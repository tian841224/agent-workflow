---
id: <YYYYMMDD-HHmmss-short-slug>
project_id: <project-id>
worktree_id: <worktree-id>
status: in_progress
code_change: <true | false>
risk_flags: []
created_at: <ISO-8601>
updated_at: <ISO-8601>
frozen_at:
---

# <任務標題>

## Goal（目標）

<要完成或確認什麼>

## Scope（範圍）

<會修改／審查／驗證哪些行為；不處理哪些項目>

## Completion criteria（完成條件）

- [ ] 預期行為或審查目標完成
- [ ] 相關驗證通過

## Validation results（驗證結果）

- pre-review: <PASS | FAIL | SKIP>
- command: <實際命令>
- checks: <執行項目與結果>
- skip reason: <只有 SKIP 時填寫>
- limitations: <未驗證限制；無則填 none>

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

<!-- code_change: true 時加入：
## Execution path and regression evidence（執行路徑與回歸證據）
<入口 > 上游 > 修改點 > 下游終點；列出重要錯誤／重送／並發／異步分支與驗證證據>

## Reviewer result（Reviewer 結果）
## Verifier result（Verifier 結果）
-->

<!-- 其他條件式段落：
behavior_change／ui：## Acceptance cases（驗收案例）
contract／schema／data_write／financial／migration：## Contract and data impact（契約與資料影響）
cross_feature／migration／irreversible：## Implementation sequence（實作順序、依賴與回滾點）
ui：## Browser verification（browser 畫面驗證）
refactor：## Behavior invariants and before-after evidence（行為不變條件與前後證據）
-->
