---
name: project-docs
description: 修改 application source code 前載入；先以 project-doc Lookup 查出涵蓋本次路徑的文件並讀過再動手，改完後依查詢結果建立缺少的文件或更新已失準的內容。
---

# Project Docs

目標 repo 的 `docs/`，回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」。跨 task、跨 repo 的框架級教訓走 knowledge／retro，不走這裡。

## 1. 動手前：Lookup

```text
agent-workflow project-doc --action Lookup --task-path <task> --repo-root <repo-root> --paths '<本次要動的路徑>'
```

在 workflow task 內一律帶 `--task-path`：runtime 會比對 `project_docs.read` 與 `project_docs.digests`，已讀且內容未變的文件回報 `digest_status: reusable`，同一 task 即使中斷、重啟 agent 或從 review 折返 implementation 也不必重讀。`unread`、`digest_missing` 與 `stale` 都要實際讀過才算數。

回傳真正命中的文件、可延後讀取的 `overview_candidates`（含 `content_sha256`），以及 `uncovered`。先讀命中的文件；只有 compiled plan 的 `exploration_profile`、影響面或共享狀態需要時才讀 overview，overview candidate 一律先保持 `unread`。文件與現況程式不一致時以程式為準，並把差異列入下一步要修的內容。

讀完文件後執行 `agent-workflow project-doc --action Remember --task-path <task> --repo-root <repo-root> --paths <doc,...>`，把實際讀過的路徑與 `content_sha256` 寫入 task.json，下一次 Lookup 才能重用。

## 2. 改完後：依查詢結果處理

| 查詢結果 | 處理 |
|---|---|
| 命中，且本次改動沒有改變文件記錄的事實 | 記 no-op，不改寫 |
| 命中，但入口、流程骨架、共用狀態、契約或假設已與文件不符 | 原地更新受影響的區塊 |
| `uncovered` | 見下方判準；不是每次 `uncovered` 都要建立文件 |

判準是「文件記錄的事實是否仍成立」，不是「有沒有改到檔案」——只動不影響流程骨架的實作細節時，正確結果就是 no-op。為了填欄位重寫既有文件只會產出沒有資訊量的內容。

`uncovered` 只有符合下列其中之一才建立文件：

- 跨模組流程
- 公開 API／契約
- 共用狀態或不變量（invariant）
- 不直觀但重要的 entrypoint
- 難以逆轉的架構決策
- 只看程式碼很難快速恢復的脈絡

單純的 local bug fix、單一函式行為、簡單 CRUD 或 implementation detail 都不符合，記 `no-op: documentation not warranted`。長期重複改同一小模組仍逐次判斷，不因為「之前改過」就自動升級。

新增或修改對外端點時，`docs/api/<slug>.md` 沒有就建立、已有就核對 request／response／errors 是否仍正確。

要建立或改寫文件時才讀 [doc-types.md](references/doc-types.md)：`docs/` 佈局與 doc_type 路由、frontmatter 與 `covers` 寫法、各型別的必要區塊、從 task 既有欄位收割內容的對照表，以及 `List`／`Stale`／`Check` 三個查詢 action。

## 3. 在 workflow task 內

透過 `agent-workflow task-write` 只填入 task.json 的 `project_docs.updated`：本次建立或更新的文件路徑，沒有文件要動就填 `none - <具體理由>`。`project_docs.read` 與 `project_docs.digests` 一律由 `project-doc --action Remember` 寫入；task-write 更新 `updated` 時會保留既有的 read／digest 證據。需要人工閱讀時執行 `agent-workflow task-report`。
