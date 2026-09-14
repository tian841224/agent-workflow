---
name: task-retrospective
description: Retrospective recording explicitly requested by the user. Load only when the user asks to track or analyze this task's workflow execution, hook/skill usage, timing, errors, retries, or workflow friction; never auto-load merely because a task ends, fails, or uses managed workflow.
---

# Task Retrospective

這是一個 opt-in 診斷 skill。只有使用者明確要求記錄或分析某個任務的實際執行情況時才啟用；一般任務完全不增加追蹤、文件、gate、驗證或 hook 成本。

## 啟用模式

### Track mode

在任務開始前或執行中啟用時，從啟用點開始維護本次 task 的輕量 ledger。記錄可觀察到的時間戳、主要階段、hook/skill 事件、錯誤、retry、額外工具往返與 recovery；不要為了 retrospective 額外重跑 command 或驗證。

只追蹤目前選定的 task。任務完成、中止、blocked、failed、superseded，或使用者要求停止時結束追蹤；下一個 task 不自動延續。

### Analyze-only mode

任務結束後才啟用時，只使用現有 task/evidence/review 紀錄、hook/CLI/tool 結果與可見 session history 還原。無法可靠還原的次數、時間或原因標為 `unavailable`，不要猜測。

## Evidence discipline

資料可信度依序為：

1. runtime／hook 自動紀錄或實測 duration
2. task lifecycle、evidence、review、CLI receipt
3. tool／command result 與可見 session transcript
4. 可由事件順序直接推導的資料
5. agent 估計

所有時間或次數標記 `measured`、`derived`、`estimated` 或 `unavailable`。估計值不得偽裝成精確量測。

每份報告記錄可取得的 workflow/runtime version 或 commit、platform、repository、branch、task id、managed_change、risk flags 與 outcome。歷史 finding 只代表當時版本；提出改善前先確認目前版本仍存在同一問題。

## Track what matters

### Execution

記錄真正影響任務成本或決策的階段：requirement clarification、exploration、planning、implementation、validation、review、delivery、workflow administration、error recovery。使用者等待時間獨立標示，不算 workflow 執行成本。

### Hooks

對每個實際觀察到的 hook 聚合：

- hook name 與 lifecycle event
- invocation／allow／block／warning／error 次數
- 因 block 造成的 retry 次數
- cumulative／max duration，只有可量測時才填
- recurring reason 或 reason sequence

同一操作被連續阻擋時保留 attempts、每輪 reason 與 final resolution，用來辨識 false positive、規則不穩定與 retry amplification。

### Skills

區分三種事件：

- `skill_load`：agent 實際讀取 skill
- `policy_injection`：hook/runtime 注入由 skill 編譯出的 policy，但沒有讀完整 skill
- `skill_reference`：procedure 或文件只提到該 skill，不算已執行

記錄 load/injection 次數、首次 trigger、重複載入與是否真的影響決策。沒有可靠證據時，不從文字提及推論 skill 已觸發。

### Errors and retries

只記錄會增加成本、影響正確性或暴露 workflow 問題的事件。每個 root cause 聚合：phase、component、operation、error、attempts、recovery、extra calls、extra duration 與 owner。

owner 使用 `workflow | runtime | hook | skill | adapter | agent | project | environment | external | unknown`。

## Necessary cost vs friction

不要因某一步耗時就判定 workflow 有問題。

通常屬於 necessary cost：依風險要求的 safety gate、intent confirmation、reviewer、必要 validation、真實 scope conflict 的釐清，以及確實增加 correctness evidence 的探索。

優先視為 avoidable friction：重複讀取／判斷／驗證、CLI 文件與 contract 不一致、只能靠 trial-and-error 找參數、hook false positive、同一內容被反覆 block、block reason 在 retry 間漂移、stale script/path、task 自己產生的暫存檔使 evidence 失效、已完成的 confirmation 被再次要求、沒有增加 evidence 的角色或工具往返、該觸發卻沒觸發或反覆重載的 skill。

## Workflow findings

只有具體 evidence 才建立 finding：`priority`、`owner`、`problem`、`evidence`、`occurrences`、`avoidable_cost`、`root_cause`、`recommended_change`、`risk_of_change`、`confidence`。

- `P0`：會造成 correctness／safety／資料風險，或讓正常 task 無法完成。
- `P1`：可重複且造成明顯 retry、時間、token 或工具成本。
- `P2`：值得改善，但成本低、頻率低或證據仍不足。

一次偶發且無法證明 root cause 的事件只列 observation。

提出修改前確認問題確實由 workflow/runtime/hook/skill 擁有、不是任務本質成本，且改善不降低 correctness、safety 或 verification。優先修改最接近 root cause 的 owner，不用全域規則解決單一 project 的局部問題。

本 skill 只分析與提出 candidate，不在 retrospective 階段順手修改 workflow。若 finding 需要成為長期規則，累積獨立證據後再交給既有 learn／distill 流程。

## Finalize

任務結束時讀 [references/report.md](references/report.md) 產生報告。正常且沒有 error、retry、hook block、重複 skill load 或 finding 的任務使用 compact 版本；不要為了報告完整而產生流水帳。
