# 自動平行編排

主對話完成需求與拆分判定後即可使用此能力。runtime 不自行判斷任務語意；它只驗證明確的 `parallelization` 規格、建立隔離 worktree、派發子 task、收集 patch 並整合。若 host 提供原生 agent collaboration，主對話可直接使用；`AGENT_WORKFLOW_<PLATFORM>_DISPATCH_COMMAND` 僅是 runtime detached-worktree 派發的跨平台介面。

## 拆分規格

至少兩個 worker，每個 worker 需要 `id`、`title`、`goal`、`completion_criteria` 與不重疊的 `file_ownership`。無順序相依、無共用持久化狀態，且 ownership 不得含 schema、contract、route、registry、barrel、lockfile 或 i18n 等共用整合點。

不符合條件時，主對話直接循序處理並記錄原因；不得建立 worktree。

## Dirty worktree snapshot

`Init` 使用 temporary `GIT_INDEX_FILE` 將目前 tracked、staged、unstaged 與 untracked 內容做成無 ref 的暫時 base commit。不得執行真實 `git add`，不得改變使用者 index 或 branch。

每個 detached worker worktree 都從該 snapshot 建立。套用前會重算主工作目錄 snapshot；內容已變動時拒絕 Apply，不覆寫使用者後續修改。

## 生命週期

```text
Assess -> Init/Dispatch -> worker implementation -> Collect
       -> Integrate successful patches -> Apply -> Cleanup
       -> 主對話補齊失敗範圍 -> 全體 Review/驗證
```

`Init` 自動透過 Codex、Claude 或 Antigravity 的 dispatcher 啟動 worker。dispatcher 回覆必須回顯指定 worktree 與 parent task id，否則整批建立失敗並清理。

worker 只實作自己的 ownership，完成回報後直接結束；不跑測試、pre-review、Review、Verifier 或 task gate。worker 失敗、逾時、越權或無法整合時，成功的獨立 patch 可保留，失敗範圍由主對話循序完成。

所有原始完成條件完成之前，主對話不得開始 Review 或驗證。

## 平台 adapter

三平台皆以 `AGENT_WORKFLOW_<PLATFORM>_DISPATCH_COMMAND` 接收 JSON stdin。回覆 JSON 必須為：

```json
{"accepted": true, "dispatch_id": "native-id", "worker_root": "<指定 worktree>", "parent_task_id": "<母 task>"}
```

adapter 必須使用平台原生方式建立 worktree-bound agent；共享主工作目錄不符合此契約。每個平台需完成真實雙 worker 驗收後，才能標示為自動平行支援。
