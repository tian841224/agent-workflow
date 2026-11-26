---
doc_type: module
covers:
  - adapters/claude/
  - adapters/codex/
  - adapters/antigravity/
  - src/work-reminders.ts
  - src/session-cleanup.ts
  - tests-node/adapters/
---

# Platform context hooks

## Responsibility

平台 hook templates 提供語言規則與相關記憶的注入，以及 session 結束時的一次性資源清理（`src/session-cleanup.ts`）。Git 操作的使用者授權要求由 [AGENTS.md](../../AGENTS.md) 管理，安裝器不註冊自動 Git guard；Claude 另由 `permissions.ask` 讓平台在強制 push、`reset --hard`、`clean -f`、`branch -D` 等破壞性指令前跳出確認；commit、push、rebase、merge 等非破壞性指令只需使用者同意，平台不另外詢問。Claude 還有兩個一次性提醒（`src/work-reminders.ts`），避免 agent 在 session 中離開 managed workflow。

## Entrypoints

Claude／Codex 的 `UserPromptSubmit` 執行 `locale-context` 與 `memory-context`；Antigravity 的首次 `PreInvocation` 提供語言規則與記憶導航。`src/installer.ts` 的 `mergeHook` 將 templates 寫入平台設定。

Claude 的 `UserPromptSubmit` 另執行 `task-reminder`：目前 worktree 有 `in_progress`、`paused` 或 `blocked` 的 task 時，每個 session 提醒一次，列出 task 路徑與 `close-task`／`resume`／`supersede`。Claude 的 `PostToolUse`（matcher `Edit|Write|MultiEdit`）執行 `edit-reminder`：session 工作目錄內累計修改 5 個不同的非文件檔案（`.md`、`.mdx`、`.txt`、`.rst`、`.adoc` 不算）、而且沒有未結案 task 時，提醒一次依 AGENTS.md 重新判斷 `managed_change`。兩者只注入 context，失敗一律靜默結束；沒有 session id 時不提醒。

Session 清理：Claude／Codex 的 `SessionStart` 執行 `session-start`、`SessionEnd` 執行 `session-cleanup`；Antigravity 的首次 `PreInvocation` 執行 `session-start`、`Stop` 執行 `session-cleanup`。三者都走輕量的 `agent-workflow-hook.mjs`。Windows 的 Codex 安裝會產生 `commandWindows`，以編碼參數保留 Node 的絕對路徑與 stdin。變更 handler 後，Codex 依自己的信任機制重新核對定義。

## Flow

`install / repair > removeOwnHooks > render platform template > merge user hooks > write settings`

安裝器以受管 runtime 的 bundle 與 hook 子命令辨識自有 handler。提示型 hook 使用受管標記，Antigravity 另使用 `agent-workflow-` key。Codex 在原有群組及 handler 位置更新相符的 hook，只追加缺少的定義，保留現有使用者 hook 的位置供 Codex 對應信任狀態。退役 handler 仍會清除，若同一群組因此有使用者 handler 改了位置，Codex 會重新要求確認。

`install / repair > ensureClaudeAskRules > settings.json permissions.ask`：把 `adapters/claude/settings.permissions.json` 的規則補進 Claude 設定，已存在的不重複，使用者自己的規則保留；新增的規則記在 `managed-runtime.json` 的 `claude_permissions.ask`。使用者手動刪掉其中一條後，下一次 repair 會補回；模板縮減時舊規則留到 uninstall 才移除。

`uninstall > removeOwnHooks > write settings`（對每個平台，先於刪除 runtime）

Uninstall 也只移除 `claude_permissions.ask` 記錄的規則。Uninstall 以同一個 `removeOwnHooks` 清除 `managed-runtime.json` 記錄的 Claude、Codex、Antigravity hook 檔，使用者自己的 hook 與設定保留；沒有自有 hook 時不寫檔。清除後 Claude／Codex 留下各事件的空陣列（例如 `"UserPromptSubmit": []`）加上使用者內容，Antigravity 移除 `agent-workflow-` 開頭的頂層 key。hook template 只從安裝來源讀取，不存在於共用 runtime。

`session-start > write <state-root>/sessions/<platform>-<hash>.json（起點、transcript、scratchpad）`

- Codex 的 `SessionEnd` 移除該 session 的紀錄與 framework 暫存標記，再寫入 `logs/session-cleanup.jsonl`。Codex 的 app server 與系統暫存目錄可能同時由多個對話使用，因此保留共用程序與暫存檔。
- Claude 的 `SessionEnd` 依程序關係清理存活子程序，掃描允許的暫存時間窗並寫入清理紀錄。Antigravity 的 `Stop` 只處理暫存檔。

- agent 程序是 hook 往上第一個非 shell 的祖先；hook 自己的祖先鏈不會被終止。
- 子孫的判定排除 Windows 的 PID 重用：子程序的建立時間早於父程序，代表它是已結束父程序的孤兒，不是真正的子孫，不終止。終止時逐一指定 PID，不用 `taskkill /T`，避免它沿著同樣過期的父子連結走到不相干的程序。
- Claude `SessionEnd` 的 reason 為 `clear`／`resume` 時 agent 仍在執行，只清暫存檔、不終止程序。Antigravity 永不終止程序，且 `fullyIdle: false` 時什麼都不清。
- 暫存檔只刪建立時間不早於本 session 起點，而且早於其他每個進行中 session 起點的項目；進行中指 transcript（沒有就看紀錄檔）12 小時內有更新，過期的紀錄順手刪除。沒有本 session 的紀錄時略過暫存檔清理。包含 state root 或其他 session scratchpad 的項目不刪。

## Shared state

平台設定保存已安裝 hooks。`managed-runtime.json` 保存 runtime 路徑與安裝紀錄。選用的 `adapters/codex/execpolicy.rules` 以 prompt 要求破壞性 Git 操作確認；目前安裝器不寫入該 rules 檔。

## Invariants and gotchas

- `edit-reminder` 在每次 Edit／Write 都會啟動一個 node 程序，但門檻之前只讀寫 `os.tmpdir()` 的計數檔，不解析專案、不掃描 task；兩個提醒的 session 狀態都放在同一類暫存標記，由 session 清理一併處理。
- `permissions.ask` 以規則字串比對指令：`git -C <dir> reset --hard`、經 wrapper 或變數組出的指令不保證被比對到，bypassPermissions 模式是否仍跳出確認未實機驗證；完整防護需要手動 `git-guard` 的 pattern 檢查。
- 自動 hooks 只注入 context 與清理 session 自己的一次性資源，不承擔 task 結案判定。
- `session-start`／`session-cleanup` 一律 exit 0，失敗只寫進清理紀錄；Antigravity `Stop` 回覆 `{"decision":"stop"}`，不阻止停止。
- Codex 的 `SessionEnd` 上限是 3 秒，因此執行路徑只處理當前 session 的固定檔案，省去程序查詢與暫存目錄掃描。
- 用 `Start-Process`、`nohup` 脫離父程序的程式，以及 session 異常中止後遺留的程序，不在清理範圍。
- `locale-context` 每次提交訊息都注入用詞清單；核心規則同一個 session 只在第一次注入，判斷依據是 `os.tmpdir()` 的 session 標記，payload 沒有 session id 或標記寫入失敗時照常注入。
- 手動 `git-guard` CLI 拒絕破壞性與隱藏執行 pattern；它不是必裝的自動執行步驟。
- 平台放行或 agent intent attestation 不構成使用者 Git 授權；具體要求依 AGENTS.md。
- `tests-node/adapters/parity.test.mjs` 檢查 templates 與手動 CLI 的跨平台契約；installer tests 檢查舊 guard 清除及使用者 hooks 保留。

## Unverified

隔離 install／repair 測試不證明使用者本機設定已更新，也不證明既有 session 已重新載入 hooks。Claude 桌面版封存 session 或關閉 App 時是否觸發 `SessionEnd`，官方文件沒有記載，需看 `logs/session-cleanup.jsonl` 是否有紀錄；Codex 的 3 秒上限在 Windows 上是否足夠、Antigravity 的實際 hook 行為，也只能在實機確認。
