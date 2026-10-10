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

平台 hook templates 提供語言規則與相關記憶的注入。Git 操作的使用者授權要求由 [AGENTS.md](../../AGENTS.md) 管理，安裝器不註冊自動 Git guard。

## Entrypoints

Claude／Codex 的 `UserPromptSubmit` 執行 `locale-context` 與 `memory-context`；Antigravity 的首次 `PreInvocation` 提供語言規則與記憶導航。`src/installer.ts` 的 `mergeHook` 將 templates 寫入平台設定。

## Flow

`install / repair > removeOwnHooks > render platform template > merge user hooks > write settings`

`removeOwnHooks` 依 managed runtime 路徑或 managed marker 辨識自有 hook；Antigravity 另以 `agent-workflow-` key 辨識。移除自有 handler 後保留同群組的使用者 handler，因此模板沒有 Git guard 時，repair 會清除舊 managed guard。

## Shared state

平台設定保存已安裝 hooks。`managed-runtime.json` 保存 runtime 路徑與安裝紀錄。選用的 `adapters/codex/execpolicy.rules` 以 prompt 要求 Git 操作確認；目前安裝器不寫入該 rules 檔。

## Invariants and gotchas

- 自動 hooks 只注入 context，不承擔 task 結案判定。
- 手動 `git-guard` CLI 保留既有拒絕語意，以維持相容性；它不是必裝的自動執行步驟。
- 平台放行或 agent intent attestation 不構成使用者 Git 授權；具體要求依 AGENTS.md。
- `tests-node/adapters/parity.test.mjs` 檢查 templates 與手動 CLI 的跨平台契約；installer tests 檢查舊 guard 清除及使用者 hooks 保留。

## Unverified

隔離 install／repair 測試不證明使用者本機設定已更新，也不證明既有 session 已重新載入 hooks。
