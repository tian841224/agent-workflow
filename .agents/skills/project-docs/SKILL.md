---
name: project-docs
description: Load when the execution packet marks durable project context as relevant to module/shared behavior, contracts, data/schema, or expanded exploration.
---

# Project Docs

目標 repo 的 `docs/` 回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」。跨 task、跨 repo 的框架級教訓走 knowledge／review-cause，不走這裡。

這個 skill 不是所有 `code_change` 的前置步驟。高信心、file-local、`local_behavior` 且沒有相關高風險邊界的修改直接依程式與測試處理；只有 execution packet 明確指向本 skill 時才做下面的 Lookup。

## 1. 動手前：Lookup

```text
agent-workflow project-doc --action Lookup --task-path <task> --repo-root <repo-root> --paths '<本次要動的路徑>'
```

在 workflow task 內一律帶 `--task-path`：runtime 會比對 `project_docs.read` 與 `project_docs.digests`，已 Remember 且內容未變的文件回報 `digest_status: reusable`。`unread`、`digest_missing` 與 `stale` 都要實際讀過才算數。frontmatter 標 `status: historical` 的文件是歷史紀錄，Lookup 不回傳。

回傳真正命中的文件、可延後讀取的 `overview_candidates`（含 `content_sha256`），以及 `uncovered`。先讀命中的文件；只有 compiled plan 的 `exploration_profile`、影響面或共享狀態需要時才讀 overview，overview candidate 一律先保持 `unread`。文件與現況程式不一致時以程式為準，並把差異列入下一步要修的內容。

Remember 不是固定步驟，gate 也不讀它。只有讀取結果需要在後續階段、Reviewer、agent 重啟或跨多輪的 expanded task 重用時，才執行 `agent-workflow project-doc --action Remember --task-path <task> --repo-root <repo-root> --paths <doc,...>` 記錄實際讀過的路徑與 `content_sha256`；同一 session 內讀完即用的短 task 不寫。

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

只有本次實際建立或更新文件時，才透過 `agent-workflow task-write` 把路徑寫入 `project_docs.updated`；沒有文件變更就不寫，不填 `none` 之類的佔位值。`project_docs.read` 與 `project_docs.digests` 一律由 `project-doc --action Remember` 寫入；task-write 更新 `updated` 時會保留既有的 read／digest 證據。需要人工閱讀時執行 `agent-workflow task-report`。
