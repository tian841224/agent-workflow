---
name: project-docs
description: 修改 application source code 前載入；先以 project-doc Lookup 查出涵蓋本次路徑的文件並讀過再動手，改完後依查詢結果建立缺少的文件或更新已失準的內容。定義目標 repo `docs/` 的佈局、各 doc_type 的必要區塊與 staleness 判斷。
---

# Project Docs

目標 repo 的 `docs/`，回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」，讓開發者快速建立專案輪廓，也讓 agent 在改動前先熟悉功能。

## 與 knowledge、retro 的分工

| | project docs | `knowledge` | `retro` |
|---|---|---|---|
| 回答 | 這塊 code 是什麼、流程怎麼走、為什麼這樣決定 | 這件事以前踩過嗎（跨 task 的框架級教訓） | 框架是不是重複漏接 |
| 檢索鍵 | path 前綴反查 | topic 關鍵字子字串 | miss_category 計數 |
| 生命週期 | 原地覆寫，只有一個現行版本；有 `covers` 的文件隨其 git 歷史自動判斷 stale | append + supersedes 鏈 | 計數到門檻才 escalate |
| 存放 | 目標 repo `docs/`，隨 code 版控、PR 看得到 | 框架 state | 框架 state |

範例：「`checkSeries` 的 free game 觸發條件與結算順序」→ module 文件；「兌換流程從下單到入帳跨了哪幾個模組」→ flow 文件；「`settle` 有兩個入口，第二個在 cron 裡」→ module 文件的 `## Entrypoints`（結構事實，grep 找不到）；「為什麼金額一律用 decimal，不用 float」→ decision 文件（在 repo 內、隨 code 版控、covers 對到的程式一改就會被標 stale）；「這個框架本身重複漏接同一種問題」→ knowledge／retro（跨 task、跨 repo 的框架級教訓）；「Reviewer 沒抓到第二個呼叫端，第二次了」→ retro。單次筆誤或單點邏輯錯誤三邊都不寫。

## 佈局

```text
docs/
├─ architecture.md         系統總覽與分層（一份）
├─ structure.md            資料夾結構與檔案放置規則（一份）
├─ dataflow.md             跨模組主要資料流（一份）
├─ flows/<slug>.md         功能流程（多份，need-driven；以功能為單位、可跨模組）
├─ modules/<slug>.md       模組文件（多份，need-driven）
├─ api/<slug>.md           API 規格（多份，need-driven；新增或修改對外端點時建立）
├─ decisions/<slug>.md     決策記錄（多份，need-driven；見「Decision 文件四區塊」）
└─ glossary.md             詞彙表（一份，need-driven；見「Glossary 建立與讀取時機」）
```

**一份文件只裝一個 doc_type、一個主題。** 內容變長時依 `covers` 或功能邊界拆成多份各自內聚的文件，讓 Lookup 只回傳相關的那幾份，讀的人不必掃過大量無關內容。不設行數上限——腐化的來源是「記了會過期的細節」，不是長度，各區塊表格的「不記」欄已處理這點。

repo 已有 docs 慣例時沿用既有位置與命名，只補下列兩個 frontmatter 欄位。

## Frontmatter

```yaml
---
doc_type: architecture | structure | dataflow | flow | module | api | decision | glossary
covers: ["game/gameList/Seth_10017/", "game/commonLogic/checkSeries/"]
---
```

`covers` 路徑文法與 `file_ownership` 相同（repo-relative、`/` 分隔、不得含 `..`／`[`／`]`／反斜線）：以 `/` 結尾為目錄前綴，否則為精確檔案。`architecture.md`／`structure.md`／`dataflow.md`／`glossary.md` 的 `covers` 不參與比對（Lookup 一律附帶），僅供人閱讀或留空；`flow`、`module`、`api`、`decision` 文件的 `covers` 必填，照常參與比對與 staleness 判斷。

## 同步流程

改 application source code 之前先查、改完之後依查詢結果決定要不要動文件。每個 code change 都執行，動手前那一步是唯讀查詢，成本很低。

1. **動手前**：`project-doc --action Lookup --paths '<本次要動的路徑>'`，讀命中的文件建立脈絡。文件與現況程式不一致時以程式為準，並把差異列入下一步要修的內容。
2. **改完後**，依 Lookup 結果逐項處理：

| 查詢結果 | 處理 |
|---|---|
| 命中，且本次改動沒有改變文件記錄的事實 | 記 no-op，不改寫 |
| 命中，但入口、流程骨架、共用狀態、契約或假設已與文件不符 | 原地更新受影響的區塊 |
| `uncovered`（本次路徑沒有任何文件涵蓋） | 依「佈局」建立對應文件 |

判準是「文件記錄的事實是否仍成立」，不是「有沒有改到檔案」——只動不影響流程骨架的實作細節時，正確結果就是 no-op。`Stale` 的結果只當線索，一律以現況程式為準。

新增或修改對外端點時，`docs/api/<slug>.md` 沒有就建立、已有就核對 request／response／errors 是否仍正確。

## Architecture、Structure、Dataflow 三份總覽的分工

| 文件 | 回答 | 不回答 |
|---|---|---|
| `architecture.md` | 系統由哪些部分組成、分層與邊界、對外依賴 | 單一功能的執行順序 |
| `structure.md` | 程式碼實體上放在哪、新檔案該放哪 | 執行期行為 |
| `dataflow.md` | 資料跨模組怎麼流動與落地 | 單一功能的分支細節（那是 flow 文件） |

## Structure 文件三區塊

`covers` 留空，Lookup 一律附帶。目錄增刪、分層調整或放置規則改變時更新。

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Layout` | 目錄樹，每個目錄一行職責 | 逐檔清單（`ls` 一次就有） |
| `## Placement rules` | 新檔案依類型該放哪個目錄、哪些目錄只放特定東西、命名慣例 | 語言通用慣例 |
| `## Unverified` | 用途追不出來的目錄與原因；無則 `none` | — |

## Flow 文件四區塊

以**功能**為單位、可跨模組，回答「這個功能端到端怎麼走」；module 文件以**模組**為單位，回答「這個模組做什麼」。跨模組的功能流程寫成獨立 flow 文件，不塞進其中任一模組。`covers` 填這條流程實際經過的路徑（可涵蓋多個模組），程式一改就會被標 `stale`。

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Trigger` | 誰或什麼事件啟動這條流程（使用者操作、HTTP route、cron、MQ） | 認證細節（在 api 文件） |
| `## Steps` | `A > B > C` 符號骨架，標出跨模組的交界 | 行號、函式簽名、參數型別 |
| `## Failure modes` | 失敗、逾時、重送、補償與冪等行為 | 「這裡要小心」這類無資訊量句子 |
| `## Unverified` | 追不完的節點與原因；無則 `none` | — |

## Module 文件六區塊

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Responsibility` | 負責什麼、不負責什麼（1–3 行） | 實作細節 |
| `## Entrypoints` | HTTP route／cron／MQ topic／被誰呼叫 | 呼叫端完整清單（反向搜尋一次就有） |
| `## Flow` | 模組內部的 `A > B > C` 符號骨架、重要錯誤／重送／並發分支 | 跨模組全程（那是 flow 文件）、行號、函式簽名 |
| `## Shared state` | 同 table／redis key／全域變數的其他寫入者 | schema 欄位逐條 |
| `## Invariants and gotchas` | 為什麼長這樣、不能動的假設、踩過的坑 | 「這裡很重要」這類無資訊量句子 |
| `## Unverified` | 追不完的節點與原因；無則 `none` | — |

## API 文件七區塊

`covers` 指向實作該端點的路由／handler 檔案，一個端點（或一組緊密相關的端點）一份文件；沒有對外 API 的專案不建立這個資料夾。跟 module 文件不同，這裡**刻意記錄完整 request／response schema**——API 是外部契約，變動必須讓呼叫端立刻看到差異，省略細節反而失去這份文件存在的意義；route/handler 一改就會被標 `stale`，不會悄悄過期沒人知道。

| 區塊 | 記什麼 |
|---|---|
| `## Endpoint` | Method + path（例：`POST /api/exchange/prepare`），或等效的 RPC／訊息名稱 |
| `## Auth` | 認證／授權要求；無則寫 `none` |
| `## Request` | 完整參數（path／query／body）、型別、必填／選填 |
| `## Response` | 成功回應的完整 schema；沒有共用結構時逐一列出 |
| `## Errors` | 錯誤狀態碼與意義、觸發條件 |
| `## Invariants and gotchas` | 冪等性、速率限制、副作用等不寫在 schema 裡但呼叫端要知道的事 |
| `## Unverified` | 追不完的節點與原因；無則 `none` |

## Decision 文件四區塊

三個條件**同時成立**才建立：(1) 難以逆轉；(2) 沒有脈絡會讓未來讀者困惑「為什麼這樣做」；(3) 是真實 trade-off 的結果（有其他可行選項而選了這個）。三者缺一不建——單純的實作細節、沒有替代方案的必然選擇、或隨時能改的小決定，都不建立 decision 文件。

| 區塊 | 記什麼 |
|---|---|
| `## Context` | 當時的限制、需求或問題是什麼 |
| `## Decision` | 選了什麼 |
| `## Alternatives` | 考慮過的其他選項，及沒選它們的理由 |
| `## Consequences` | 這個決定帶來的取捨、之後要注意什麼 |

`covers` 指向被這個決策影響的程式路徑；程式一改，`stale` 就會被標起來——這是 decision 文件優於外部 ADR 檔案的地方，決策的有效性和程式碼綁在一起判斷，不需要另外維護。

## Glossary 建立與讀取時機

第一次出現「同一概念在程式與對話裡用了不同詞」或「同一個詞指涉兩件事」時建立 `docs/glossary.md`，一次記一則，不批次補齊。`covers` 留空，Lookup 一律附帶；Review 的 `Mysterious Name` 判斷以它為基準。只有一個 `## Terms` 區塊，逐則列出術語與定義。

## `project-doc`

```text
$pd = Join-Path $env:USERPROFILE '.agent-workflow\runtime\agent-workflow.mjs'
& node $pd project-doc --action Lookup --paths 'game/gameList/Seth_10017/'   # 命中文件 + uncovered，附帶 architecture/structure/dataflow/glossary
& node $pd project-doc --action List                                          # 全部文件與 stale 狀態
& node $pd project-doc --action Stale                                         # 只列 covers 路徑比文件本身更新的文件
& node $pd project-doc --action Check --doc docs/structure.md                 # frontmatter／covers／必要區塊
& node $pd project-doc --action Check --doc docs/flows/exchange.md            # 同上，flow 文件檢查四區塊
& node $pd project-doc --action Check --doc docs/modules/seth-10017.md        # 同上，module 文件檢查六區塊
& node $pd project-doc --action Check --doc docs/api/exchange-prepare.md      # 同上，api 文件檢查七區塊
```

`Stale` 只回報一種情況：涵蓋路徑最後一次提交的時間晚於文件本身最後一次提交的時間。判斷完全來自版本歷史比較，不是文件裡的欄位，不可能被手動改假；未提交的改動與未進版控的新文件都不會出現在結果中。

## 在 workflow task 內的額外欄位

以下只在走 workflow task 時適用；bypass workflow 的 code change 只做上面的「同步流程」。

`## Project docs` 的 `updated:` 是否要建立或更新文件，一律由 agent 自行判斷；`task-minimal.md`（Standard）與 `task.md`（Elevated）都內建這一行，**判斷結果要不要動文件，跟這行有沒有填是兩件事**——沒有文件要動就寫 `none - <具體理由>`，理由不得是 placeholder。Elevated task 另有 `- read:`，填動手前 Lookup 命中並讀過的文件路徑，路徑不存在一律修正；Standard task 不重複這行。

- `- read:`（僅 Elevated）：填動手前 Lookup 命中並讀過的文件路徑。
- `- updated:`（Standard／Elevated 皆有）：填本次建立或更新的文件路徑；全部命中且內容仍準確時填 `none - 已存在且準確`。**觸發的是「處理」不是「重寫」**——為了填欄位重寫既有文件只會產出沒有資訊量的內容。

從 task 既有欄位收割，不是新探索：

| task 既有欄位 | → 區塊 | 轉換 |
|---|---|---|
| `Impact surface` 觸發入口 | `## Entrypoints`／`## Trigger`／`## Endpoint` | 原樣搬 |
| `Impact surface` 共用狀態 | `## Shared state` | 原樣搬 |
| `Impact surface` 未確認節點 | `## Unverified` | 原樣搬 |
| `Execution path and regression evidence` | `## Flow`／`## Steps` | 刪掉行號與驗證證據，只留符號骨架 |
| `Contract and data impact` | `## Request`／`## Response`／`## Errors` | 原樣搬（API 文件需要的正是這裡已經寫好的完整契約細節） |
| `Decision and tradeoffs` | decision 文件的 `## Decision`／`## Alternatives`／`## Consequences` | 原樣搬，不重新探索 |
| Review 回報的路徑差異 | `## Entrypoints`／`## Flow`／`## Steps` | 補進去（獨立重建才發現的節點，價值最高） |
| 本次踩到的假設／限制 | `## Invariants and gotchas`／`## Failure modes` | 一句話 |
