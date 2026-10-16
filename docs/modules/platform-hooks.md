---
doc_type: module
covers:
  - adapters/claude/
  - adapters/codex/
  - adapters/antigravity/
  - tests-node/adapters/
---

# Platform context hooks

## Responsibility

平台 hook templates 提供語言規則與相關記憶的注入，以及 session 結束時的一次性資源清理（`src/session-cleanup.ts`）。Git 操作的使用者授權要求由 [AGENTS.md](../../AGENTS.md) 管理，安裝器不註冊自動 Git guard。

## Entrypoints

Claude／Codex 的 `UserPromptSubmit` 執行 `locale-context` 與 `memory-context`；Antigravity 的首次 `PreInvocation` 提供語言規則與記憶導航。`src/installer.ts` 的 `mergeHook` 將 templates 寫入平台設定。

Session 清理：Claude／Codex 的 `SessionStart` 執行 `session-start`、`SessionEnd` 執行 `session-cleanup`；Antigravity 的首次 `PreInvocation` 執行 `session-start`、`Stop` 執行 `session-cleanup`。三者都走輕量的 `agent-workflow-hook.mjs`。

## Flow

`install / repair > removeOwnHooks > render platform template > merge user hooks > write settings`

`removeOwnHooks` 依 managed runtime 路徑或 managed marker 辨識自有 hook；Antigravity 另以 `agent-workflow-` key 辨識。移除自有 handler 後保留同群組的使用者 handler，因此模板沒有 Git guard 時，repair 會清除舊 managed guard。

`uninstall > removeOwnHooks > write settings`（對每個平台，先於刪除 runtime）

Uninstall 以同一個 `removeOwnHooks` 清除 `managed-runtime.json` 記錄的 Claude、Codex、Antigravity hook 檔，使用者自己的 hook 與設定保留；沒有自有 hook 時不寫檔。清除後 Claude／Codex 留下 `{"hooks": {"UserPromptSubmit": []}}` 加上使用者內容，Antigravity 移除 `agent-workflow-` 開頭的頂層 key。hook template 只從安裝來源讀取，不存在於共用 runtime。

`session-start > write <state-root>/sessions/<platform>-<hash>.json（起點、transcript、scratchpad）`

`session-cleanup > find agent process > kill its surviving descendants > sweep os.tmpdir() > remove own markers and record > append logs/session-cleanup.jsonl`

- agent 程序是 hook 往上第一個非 shell 的祖先；hook 自己的祖先鏈不會被終止。
- 子孫的判定排除 Windows 的 PID 重用：子程序的建立時間早於父程序，代表它是已結束父程序的孤兒，不是真正的子孫，不終止。終止時逐一指定 PID，不用 `taskkill /T`，避免它沿著同樣過期的父子連結走到不相干的程序。
- Claude `SessionEnd` 的 reason 為 `clear`／`resume` 時 agent 仍在執行，只清暫存檔、不終止程序。Codex 有其他進行中的 Codex session 時不終止程序（它們共用同一個 agent 程序）。Antigravity 永不終止程序，且 `fullyIdle: false` 時什麼都不清。
- 暫存檔只刪建立時間不早於本 session 起點，而且早於其他每個進行中 session 起點的項目；進行中指 transcript（沒有就看紀錄檔）12 小時內有更新，過期的紀錄順手刪除。沒有本 session 的紀錄時略過暫存檔清理。包含 state root 或其他 session scratchpad 的項目不刪。

## Shared state

平台設定保存已安裝 hooks。`managed-runtime.json` 保存 runtime 路徑與安裝紀錄。選用的 `adapters/codex/execpolicy.rules` 以 prompt 要求 Git 操作確認；目前安裝器不寫入該 rules 檔。

## Invariants and gotchas

- 自動 hooks 只注入 context 與清理 session 自己的一次性資源，不承擔 task 結案判定。
- `session-start`／`session-cleanup` 一律 exit 0，失敗只寫進清理紀錄；Antigravity `Stop` 回覆 `{"decision":"stop"}`，不阻止停止。
- 用 `Start-Process`、`nohup` 脫離父程序的程式，以及 session 異常中止後遺留的程序，不在清理範圍。
- `locale-context` 每次提交訊息都注入用詞清單；核心規則同一個 session 只在第一次注入，判斷依據是 `os.tmpdir()` 的 session 標記，payload 沒有 session id 或標記寫入失敗時照常注入。
- 手動 `git-guard` CLI 拒絕破壞性與隱藏執行 pattern；它不是必裝的自動執行步驟。
- 平台放行或 agent intent attestation 不構成使用者 Git 授權；具體要求依 AGENTS.md。
- `tests-node/adapters/parity.test.mjs` 檢查 templates 與手動 CLI 的跨平台契約；installer tests 檢查舊 guard 清除及使用者 hooks 保留。

## Unverified

隔離 install／repair 測試不證明使用者本機設定已更新，也不證明既有 session 已重新載入 hooks。Claude 桌面版封存 session 或關閉 App 時是否觸發 `SessionEnd`，官方文件沒有記載，需看 `logs/session-cleanup.jsonl` 是否有紀錄；Codex 的 3 秒上限在 Windows 上是否足夠、Antigravity 的實際 hook 行為，也只能在實機確認。
