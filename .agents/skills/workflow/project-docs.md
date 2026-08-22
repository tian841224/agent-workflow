# Project Docs

目標 repo 的 `docs/`，回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」；讀寫時機見 [SKILL.md](SKILL.md) 第 1、4 節。

## 與 knowledge、retro 的分工

| | project docs | `knowledge.py` | `retro.py` |
|---|---|---|---|
| 回答 | 這塊 code 是什麼、流程怎麼走、為什麼這樣決定 | 這件事以前踩過嗎（跨 task 的框架級教訓） | 框架是不是重複漏接 |
| 檢索鍵 | path 前綴反查 | topic 關鍵字子字串 | miss_category 計數 |
| 生命週期 | 原地覆寫，只有一個現行版本；`decision` 文件隨 `covers` 的 git 歷史自動判斷 stale | append + supersedes 鏈 | 計數到門檻才 escalate |
| 存放 | 目標 repo `docs/`，隨 code 版控、PR 看得到 | 框架 state | 框架 state |

範例：「`checkSeries` 的 free game 觸發條件與結算順序」→ project docs（結構）；「`settle` 有兩個入口，第二個在 cron 裡」→ project docs 的 `## Entrypoints`（結構事實，grep 找不到）；「為什麼金額一律用 decimal，不用 float」→ `decision` 文件（在 repo 內、隨 code 版控、covers 對到的程式一改就會被標 stale）；「這個框架本身重複漏接同一種問題」→ knowledge／retro（跨 task、跨 repo 的框架級教訓）；「Reviewer 沒抓到第二個呼叫端，第二次了」→ retro。單次筆誤或單點邏輯錯誤三邊都不寫。

## 佈局

```text
docs/
├─ architecture.md        系統總覽（一份）
├─ dataflow.md             跨模組主要資料流（一份）
├─ modules/<slug>.md       模組文件（多份，need-driven）
├─ api/<slug>.md           API 規格（多份，need-driven；新增或修改對外端點時才建立）
├─ decisions/<slug>.md     決策記錄（多份，need-driven；見下方「Decision 建立時機」）
└─ glossary.md             詞彙表（一份，need-driven；見下方「Glossary 建立時機」）
```

repo 已有 docs 慣例時沿用既有位置與命名，只補下列兩個 frontmatter 欄位。

## Frontmatter

```yaml
---
doc_type: architecture | dataflow | module | api | decision | glossary
covers: ["game/gameList/Seth_10017/", "game/commonLogic/checkSeries/"]
---
```

`covers` 路徑文法與 `file_ownership` 相同（repo-relative、`/` 分隔、不得含 `..`／`[`／`]`／反斜線）：以 `/` 結尾為目錄前綴，否則為精確檔案。`architecture.md`／`dataflow.md`／`glossary.md` 的 `covers` 不參與比對（Lookup 一律附帶），僅供人閱讀或留空；`decision` 文件的 `covers` 必填且照常參與比對與 staleness 判斷。

## Module 文件六區塊

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Responsibility` | 負責什麼、不負責什麼（1–3 行） | 實作細節 |
| `## Entrypoints` | HTTP route／cron／MQ topic／被誰呼叫 | 呼叫端完整清單（反向搜尋一次就有） |
| `## Flow` | `A > B > C > D` 符號骨架、重要錯誤／重送／並發分支 | 行號、函式簽名、參數型別 |
| `## Shared state` | 同 table／redis key／全域變數的其他寫入者 | schema 欄位逐條 |
| `## Invariants and gotchas` | 為什麼長這樣、不能動的假設、踩過的坑 | 「這裡很重要」這類無資訊量句子 |
| `## Unverified` | 追不完的節點與原因；無則 `none` | — |

**不設行數上限。** 篇幅過長時依 `covers` 拆成多份各自內聚的文件，讓 Lookup 只回傳相關的那幾份，而不是砍內容——腐化的來源是「記了會過期的細節」，不是長度，上面「不記」欄已處理這點。

## API 文件七區塊

`covers` 指向實作該端點的路由／handler 檔案，一個端點（或一組緊密相關的端點）一份文件，need-driven；沒有對外 API 的專案不建立這個資料夾。跟 module 文件不同，這裡**刻意記錄完整 request／response schema**——API 是外部契約，變動必須讓呼叫端立刻看到差異，省略細節反而失去這份文件存在的意義；staleness 判斷跟其他文件一樣走 `covers` 對應的 git 歷史比較（見下方 `project-doc.py`），route/handler 一改就會被標 `stale`，不會悄悄過期沒人知道。

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

三個條件**同時成立**才建立：(1) 難以逆轉；(2) 沒有脈絡會讓未來讀者困惑「為什麼這樣做」；(3) 是真實 trade-off 的結果（有其他可行選項而選了這個）。三者缺一不建——單純的實作細節、沒有替代方案的必然選擇、或隨時能改的小決定，都不建立 decision 文件。建立時機由 `SKILL.md` §4 觸發（`change_kind: feature｜refactor`，或 `risk_flags` 命中 `contract`／`schema`／`migration` 時）。讀取時機與 module／api 文件相同：`project-doc --action Lookup` 命中即讀，不另外呼叫。

| 區塊 | 記什麼 |
|---|---|
| `## Context` | 當時的限制、需求或問題是什麼 |
| `## Decision` | 選了什麼 |
| `## Alternatives` | 考慮過的其他選項，及沒選它們的理由 |
| `## Consequences` | 這個決定帶來的取捨、之後要注意什麼 |

`covers` 指向被這個決策影響的程式路徑；程式一改，`stale` 就會被標起來——這是 decision 文件優於外部 ADR 檔案的地方，決策的有效性和程式碼綁在一起判斷，不需要另外維護。

## Glossary 建立與讀取時機

第一次出現「同一概念在程式與對話裡用了不同詞」或「同一個詞指涉兩件事」時建立 `docs/glossary.md`，一次記一則，不批次補齊。`covers` 留空，Lookup 一律附帶；Reviewer 的 `Mysterious Name` 判斷以它為基準。只有一個 `## Terms` 區塊，逐則列出術語與定義。

## 從 task 收割（不是新探索）

| task 既有欄位 | → 區塊 | 轉換 |
|---|---|---|
| `Impact surface` 觸發入口 | `## Entrypoints`／`## Endpoint` | 原樣搬 |
| `Impact surface` 共用狀態 | `## Shared state` | 原樣搬 |
| `Impact surface` 未確認節點 | `## Unverified` | 原樣搬 |
| `Execution path and regression evidence` | `## Flow` | 刪掉行號與驗證證據，只留符號骨架 |
| `Contract and data impact` | `## Request`／`## Response`／`## Errors` | 原樣搬（API 文件需要的正是這裡已經寫好的完整契約細節） |
| `Decision and tradeoffs` | `decision` 文件的 `## Decision`／`## Alternatives`／`## Consequences` | 原樣搬，不重新探索 |
| Reviewer 回報的路徑差異 | `## Entrypoints`／`## Flow` | 補進去（獨立重建才發現的節點，價值最高） |
| 本次踩到的假設／限制 | `## Invariants and gotchas` | 一句話 |

## `project-doc`

```text
$pd = Join-Path $env:USERPROFILE '.agent-workflow\runtime\agent_workflow.cmd'
& $pd project-doc --action Lookup --paths 'game/gameList/Seth_10017/'   # 命中文件 + uncovered，附帶 architecture/dataflow/glossary
& $pd project-doc --action List                                         # 全部文件與 stale 狀態
& $pd project-doc --action Stale                                         # 只列 stale／stale_pending 的文件
& $pd project-doc --action Check --doc docs/modules/seth-10017.md         # frontmatter／covers／必要區塊
& $pd project-doc --action Check --doc docs/api/exchange-prepare.md       # 同上，api 文件檢查七區塊
& $pd project-doc --action Check --doc docs/decisions/decimal-money.md    # 同上，decision 文件檢查四區塊
& $pd project-doc --action Check --doc docs/glossary.md                  # 同上，glossary 只檢查 Terms 一區塊，covers 可為空
```

`stale`：涵蓋路徑在文件之後又被 commit 改動。`stale_pending`：涵蓋路徑有未提交改動而文件沒有。兩者皆源自 git 歷史比較，不是欄位，不可能被手動改假；未進版控的新文件一律 `stale: false`。`stale` 或 `stale_pending` 為 `true` 時只當線索，一律以現況程式為準。

## `read:` 與 `updated:` 的條件式使用

Elevated task 的 `## Project docs` 兩個欄位都是「列路徑，或 `none - <理由>`」；理由不得是 placeholder，路徑不存在一律修正。Standard task 不因單純局部修改而建立或更新 Project docs。

- `- read:`：在陌生模組、架構／契約／跨功能變更，或 risk flag 要求時填寫；簡單局部修正可省略。
- `- updated:`：只有 `change_kind: feature｜refactor`，或 `risk_flags` 命中 `behavior_change`／`contract`／`schema`／`cross_feature` 時填寫；純 bug fix 或 chore 不受影響。**觸發的是「處理」不是「重寫」**：涵蓋這次改動的文件不存在時才建立；已存在且內容仍準確時填 `none - 已存在且準確`，不必為了填欄位重寫既有文件。新增或修改對外 API 端點屬於這個條件下的一種情況——沒有對應 `docs/api/<slug>.md` 時建立，已有則視內容是否仍準確決定要不要更新，不是獨立門檻，也不是每次都要重建。

文件查閱的成本應與風險匹配：架構或跨模組變更需要文件脈絡，局部修正則以現況 code、呼叫端與測試為準，避免為了通過欄位檢查產生沒有資訊量的文件。
