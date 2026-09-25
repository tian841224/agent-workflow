---
name: project-docs
description: Load when task-init context reports doc_gap, when a change makes a project doc inaccurate, or when a project decision must be recorded; covers docs layout, index and doc_type rules.
---

# Project Docs

目標 repo 的 `docs/` 回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」。跨 task、跨 repo 的框架級教訓走 knowledge／review-cause，不走這裡。

開發前的文件讀取已經由 `task-init --paths` 的 `context.docs` 完成（同一套 Lookup）。本 skill 在三種情況載入：`context` 回報 `doc_gap`、這次改動讓既有文件不再正確，或需要記錄專案決策。

## 1. 動手前：讀取與補缺口

task 外或 paths 在 task 中途改變時，單獨執行 Lookup：

```text
agent-workflow project-doc --action Lookup --task-path <task> --repo-root <repo-root> --paths '<本次要動的路徑>'
```

在 workflow task 內一律帶 `--task-path`：runtime 會比對 `project_docs.read` 與 `project_docs.digests`，已 Remember 且內容未變的文件回報 `digest_status: reusable`。`unread`、`digest_missing` 與 `stale` 都要實際讀過才算數。frontmatter 標 `status: historical` 的文件是歷史紀錄，Lookup 不回傳。

回傳真正命中的文件、可延後讀取的 `overview_candidates`（含 `content_sha256`），以及 `uncovered`。先讀命中的文件；只有 compiled plan 的 `exploration_profile`、影響面或共享狀態需要時才讀 overview，overview candidate 一律先保持 `unread`。文件與現況程式不一致時以程式為準，並把差異列入下一步要修的內容。

Remember 不是固定步驟，gate 也不讀它。只有讀取結果需要在後續階段、Reviewer、agent 重啟或跨多輪的 expanded task 重用時，才執行 `agent-workflow project-doc --action Remember --task-path <task> --repo-root <repo-root> --paths <doc,...>` 記錄實際讀過的路徑與 `content_sha256`；同一 session 內讀完即用的短 task 不寫。

### 目標 repo 沒有任何專案文件

Lookup 的 `docs` 與 `overview_candidates` 都是空的，代表沒有可快速理解專案的入口。先建立 `docs/architecture.md` 與 `docs/structure.md`，再開始修改；其餘 doc_type 維持第 2 節的按需建立，不批次補齊。

- 內容來自一次讀取 repo 頂層目錄、entrypoint、設定檔與既有 README，區塊規格見 [doc-types.md](references/doc-types.md)。
- `architecture.md` 末尾列出已存在文件的連結與一行用途，作為後續文件的索引；新增文件時同步補一行。
- 追不出用途的部分寫進 `## Unverified`，不用推測填空。

### `doc_gap`：這次碰到的模組沒有文件

開發前，只為這次碰到的模組建立一份 `module` 文件（`covers` 設為模組目錄），並在 `architecture.md` 的文件索引補一行。不一次補齊整個專案；其他 doc_type 依第 2 節判準在改完後建立。單一文件只放單一主題，內容變大時依 [doc-types.md](references/doc-types.md) 拆成多份並由索引連結。

## 2. 改完後：依查詢結果處理

| 查詢結果 | 處理 |
|---|---|
| 命中，且本次改動沒有改變文件記錄的事實 | 記 no-op，不改寫 |
| 命中，但入口、流程骨架、共用狀態、契約或假設已與文件不符 | 原地更新受影響的區塊 |
| `uncovered` | 模組文件已在開發前補上；flow、api、decision 等其他類型依下方判準 |

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
