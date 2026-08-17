# Project Docs

目標 repo 的 `docs/`，回答「這塊 code 是什麼、流程怎麼走」；讀寫時機見 [SKILL.md](SKILL.md) 第 1、4 節。

## 與 knowledge、retro 的分工

| | project docs | `knowledge.ps1` | `retro.ps1` |
|---|---|---|---|
| 回答 | 這塊 code 是什麼、流程怎麼走 | 這件事以前踩過嗎 | 框架是不是重複漏接 |
| 檢索鍵 | path 前綴反查 | topic 關鍵字子字串 | miss_category 計數 |
| 生命週期 | 原地覆寫，只有一個現行版本 | append + supersedes 鏈 | 計數到門檻才 escalate |
| 存放 | 目標 repo `docs/` | 框架 state | 框架 state |

範例：「`checkSeries` 的 free game 觸發條件與結算順序」→ project docs（結構）；「`settle` 有兩個入口，第二個在 cron 裡」→ project docs 的 `## Entrypoints`（結構事實，grep 找不到）；「金額一律用 decimal」→ knowledge（決策）；「Reviewer 沒抓到第二個呼叫端，第二次了」→ retro。單次筆誤或單點邏輯錯誤兩邊都不寫。

## 佈局

```text
docs/
├─ architecture.md        系統總覽（一份）
├─ dataflow.md             跨模組主要資料流（一份）
└─ modules/<slug>.md       模組文件（多份，need-driven）
```

repo 已有 docs 慣例時沿用既有位置與命名，只補下列兩個 frontmatter 欄位。

## Frontmatter

```yaml
---
doc_type: architecture | dataflow | module
covers: ["game/gameList/Seth_10017/", "game/commonLogic/checkSeries/"]
---
```

`covers` 路徑文法與 `file_ownership` 相同（repo-relative、`/` 分隔、不得含 `..`／`[`／`]`／反斜線）：以 `/` 結尾為目錄前綴，否則為精確檔案。`architecture.md`／`dataflow.md` 的 `covers` 不參與比對（Lookup 一律附帶），僅供人閱讀。

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

## 從 task 收割（不是新探索）

| task 既有欄位 | → 區塊 | 轉換 |
|---|---|---|
| `Impact surface` 觸發入口 | `## Entrypoints` | 原樣搬 |
| `Impact surface` 共用狀態 | `## Shared state` | 原樣搬 |
| `Impact surface` 未確認節點 | `## Unverified` | 原樣搬 |
| `Execution path and regression evidence` | `## Flow` | 刪掉行號與驗證證據，只留符號骨架 |
| Reviewer 回報的路徑差異 | `## Entrypoints`／`## Flow` | 補進去（獨立重建才發現的節點，價值最高） |
| 本次踩到的假設／限制 | `## Invariants and gotchas` | 一句話 |

## `project-doc.ps1`

```powershell
$pd = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\project-doc.ps1'
& $pd -Action Lookup -Paths 'game/gameList/Seth_10017/'   # 命中文件 + uncovered，附帶 architecture/dataflow
& $pd -Action List                                         # 全部文件與 stale 狀態
& $pd -Action Stale                                         # 只列 stale／stale_pending 的文件
& $pd -Action Check -Doc docs/modules/seth-10017.md          # frontmatter／covers／必要區塊
```

`stale`：涵蓋路徑在文件之後又被 commit 改動。`stale_pending`：涵蓋路徑有未提交改動而文件沒有。兩者皆源自 git 歷史比較，不是欄位，不可能被手動改假；未進版控的新文件一律 `stale: false`。`stale` 或 `stale_pending` 為 `true` 時只當線索，一律以現況程式為準。

## `read:` 與 `updated:` 的條件式使用

Elevated task 的 `## Project docs` 兩個欄位都是「列路徑，或 `none - <理由>`」；理由不得是 placeholder，路徑不存在一律修正。Standard task 不因單純局部修改而建立或更新 Project docs。

- `- read:`：在陌生模組、架構／契約／跨功能變更，或 risk flag 要求時填寫；簡單局部修正可省略。
- `- updated:`：只有 `change_kind: feature｜refactor`，或 `risk_flags` 命中 `behavior_change`／`contract`／`schema`／`cross_feature` 時填寫；純 bug fix 或 chore 不受影響。

文件查閱的成本應與風險匹配：架構或跨模組變更需要文件脈絡，局部修正則以現況 code、呼叫端與測試為準，避免為了通過欄位檢查產生沒有資訊量的文件。
