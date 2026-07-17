# state/ — 任務檢查點

跨 session 手動接續的共用基建。制度全文見 `~/.claude/CLAUDE.md`「檢查點」章節。本流程（標準開發流程）到「本地驗收通過」為止即停止，不含 push / 部署 / 線上驗收，`next_action` 不會出現部署相關步驟。

## 檢查點檔 `<任務slug>.json`

主 Claude 在流程每個 gate 轉換時更新（一行 Bash）。欄位：

```json
{
  "task": "20260706-xxx",
  "session_id": "<當前 session transcript 檔名的 UUID>",
  "product": "<product>",
  "current_step": "2",
  "next_action": "reviewer 審查通過，開始 QA 本地驗證 A3-A5",
  "status": "running",
  "updated_at": 1751800000
}
```

- `session_id` 取法（任務開始時取一次；換 session 接續時要更新）：
  `basename "$(ls -t ~/.claude/projects/<專案目錄 slug>/*.jsonl | head -1)" .jsonl`
  （`<專案目錄 slug>` 是 Claude Code 依工作目錄產生的目錄名）
- `status` 語義：
  - `running`：進行中
  - `awaiting_user`：等使用者輸入（方案確認、白名單提問）
  - `awaiting_next_batch`：本批完成、等接續下一批
  - `done`：完成
- `updated_at` 一律 epoch 秒（`date +%s`）

## 配套檔（同目錄、同 slug）

- `<task>-handoff.md`：批次交接檔（本批完成內容、下一批輸入、地雷）
- `<task>-questions.md`：憲章白名單外的疑問累積（批次結束一併呈報，不中斷流程）

## 斷線後如何接續（手動）

本 kit 不含任何自動監控/自動復活機制。若懷疑某個任務的 session 中斷了：

1. Read `~/.claude/state/<task>.json` 確認 `status`、`current_step`、`next_action`
2. Read 同目錄的 `<task>-handoff.md`（若有）與對應 `acceptance/<task>.md` 凍結清單
3. 用 `claude --resume <session_id>` 接續該 session，或開一個新 session 並依 `next_action` 從標準開發流程對應步驟繼續
4. 完成後把該檢查點檔 `status` 設為 `done`

## 大型任務切批

批次完成後把 state 標記為 `awaiting_next_batch` 並結束該 session；下一批由使用者自己（或下次對話開始時）Read 檢查點檔與 handoff 檔後手動開新 session 接續，不會自動觸發。
