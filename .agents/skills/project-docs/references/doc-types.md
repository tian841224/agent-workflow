# 文件佈局與各 doc_type 的區塊規格

只有要建立或改寫文件內容時才讀本檔。

## doc_type 路由

```text
docs/
├─ architecture.md         系統總覽與分層（一份）
├─ structure.md            資料夾結構與檔案放置規則（一份）
├─ dataflow.md             跨模組主要資料流（一份）
├─ flows/<slug>.md         功能流程（以功能為單位、可跨模組）
├─ modules/<slug>.md       模組文件
├─ api/<slug>.md           API 規格（新增或修改對外端點時建立）
├─ decisions/<slug>.md     決策記錄
└─ glossary.md             詞彙表（一份）
```

**一份文件只裝一個 doc_type、一個主題。** 內容變長時依 `covers` 或功能邊界拆成多份各自內聚的文件，讓 Lookup 只回傳相關的那幾份。不設行數上限——腐化的來源是「記了會過期的細節」，不是長度。

repo 已有 docs 慣例時沿用既有位置與命名，只補 frontmatter：

```yaml
---
doc_type: architecture | structure | dataflow | flow | module | api | decision | glossary
covers:
  - game/gameList/Seth_10017/
  - game/commonLogic/checkSeries/
---
```

`covers` 兩種 YAML 清單寫法都可以，行內的 `covers: ["a", "b"]` 等價於上面每行一項的寫法。

`covers` 路徑文法與 `file_ownership` 相同（repo-relative、`/` 分隔、不含 `..`／`[`／`]`／反斜線）：以 `/` 結尾為目錄前綴，否則為精確檔案。`architecture.md`／`structure.md`／`dataflow.md`／`glossary.md` 的 `covers` 不參與比對（Lookup 一律附帶），可留空；`flow`、`module`、`api`、`decision` 的 `covers` 必填。

## 其他 `project-doc` action

```text
agent-workflow project-doc --action List                              # 全部文件
agent-workflow project-doc --action Stale                             # covers 路徑比文件本身更新的文件
agent-workflow project-doc --action Check --doc docs/structure.md     # frontmatter／covers／必要區塊
```

`Stale` 只回報一種情況：涵蓋路徑最後一次提交的時間晚於文件本身最後一次提交的時間。判斷完全來自版本歷史比較，不可能被手動改假；未提交的改動不會出現在結果中，未進版控的文件則因為文件側取不到提交時間而永遠被列為 stale。結果只當線索，一律以現況程式為準。

## Architecture、Structure、Dataflow 三份總覽的分工

| 文件 | 回答 | 不回答 |
|---|---|---|
| `architecture.md` | 系統由哪些部分組成、分層與邊界、對外依賴 | 單一功能的執行順序 |
| `structure.md` | 程式碼實體上放在哪、新檔案該放哪 | 執行期行為 |
| `dataflow.md` | 資料跨模組怎麼流動與落地 | 單一功能的分支細節（那是 flow 文件） |

## Structure 文件三區塊

目錄增刪、分層調整或放置規則改變時更新。

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Layout` | 目錄樹，每個目錄一行職責 | 逐檔清單（`ls` 一次就有） |
| `## Placement rules` | 新檔案依類型該放哪個目錄、哪些目錄只放特定東西、命名慣例 | 語言通用慣例 |
| `## Unverified` | 用途追不出來的目錄與原因；無則 `none` | — |

## Flow 文件四區塊

以**功能**為單位、可跨模組，回答「這個功能端到端怎麼走」。跨模組的功能流程寫成獨立 flow 文件，不塞進其中任一模組。`covers` 填這條流程實際經過的路徑（可涵蓋多個模組）。

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Trigger` | 誰或什麼事件啟動這條流程（使用者操作、HTTP route、cron、MQ） | 認證細節（在 api 文件） |
| `## Steps` | `A > B > C` 符號骨架，標出跨模組的交界 | 行號、函式簽名、參數型別 |
| `## Failure modes` | 失敗、逾時、重送、補償與冪等行為 | 「這裡要小心」這類無資訊量句子 |
| `## Unverified` | 追不完的節點與原因；無則 `none` | — |

## Module 文件六區塊

以**模組**為單位，回答「這個模組做什麼」。

| 區塊 | 記什麼 | 不記 |
|---|---|---|
| `## Responsibility` | 負責什麼、不負責什麼（1–3 行） | 實作細節 |
| `## Entrypoints` | HTTP route／cron／MQ topic／被誰呼叫 | 呼叫端完整清單（反向搜尋一次就有） |
| `## Flow` | 模組內部的 `A > B > C` 符號骨架、重要錯誤／重送／並發分支 | 跨模組全程（那是 flow 文件）、行號、函式簽名 |
| `## Shared state` | 同 table／redis key／全域變數的其他寫入者 | schema 欄位逐條 |
| `## Invariants and gotchas` | 為什麼長這樣、不能動的假設、踩過的坑 | 「這裡很重要」這類無資訊量句子 |
| `## Unverified` | 追不完的節點與原因；無則 `none` | — |

## API 文件七區塊

`covers` 指向實作該端點的路由／handler 檔案，一個端點（或一組緊密相關的端點）一份文件；沒有對外 API 的專案不建立這個資料夾。跟 module 文件不同，這裡**刻意記錄完整 request／response schema**——API 是外部契約，變動必須讓呼叫端立刻看到差異。

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

三個條件**同時成立**才建立：(1) 難以逆轉；(2) 沒有脈絡會讓未來讀者困惑「為什麼這樣做」；(3) 是真實 trade-off 的結果（有其他可行選項而選了這個）。三者缺一不建。

| 區塊 | 記什麼 |
|---|---|
| `## Context` | 當時的限制、需求或問題是什麼 |
| `## Decision` | 選了什麼 |
| `## Alternatives` | 考慮過的其他選項，及沒選它們的理由 |
| `## Consequences` | 這個決定帶來的取捨、之後要注意什麼 |

`covers` 指向被這個決策影響的程式路徑；程式一改就會被標 stale，決策的有效性和程式碼綁在一起判斷。

## Glossary

第一次出現「同一概念在程式與對話裡用了不同詞」或「同一個詞指涉兩件事」時建立 `docs/glossary.md`，一次記一則，不批次補齊。只有一個 `## Terms` 區塊，逐則列出術語與定義。Review 的 `Mysterious Name` 判斷以它為基準。

## 從 workflow task 收割內容

寫文件時從 task 既有欄位搬，不是新探索：

| task 既有欄位 | → 區塊 | 轉換 |
|---|---|---|
| `Impact surface` 觸發入口 | `## Entrypoints`／`## Trigger`／`## Endpoint` | 原樣搬 |
| `Impact surface` 共用狀態 | `## Shared state` | 原樣搬 |
| `Impact surface` 未確認節點 | `## Unverified` | 原樣搬 |
| `Execution path and regression evidence` | `## Flow`／`## Steps` | 刪掉行號與驗證證據，只留符號骨架 |
| `Contract and data impact` | `## Request`／`## Response`／`## Errors` | 原樣搬 |
| `Decision and tradeoffs` | decision 文件的 `## Decision`／`## Alternatives`／`## Consequences` | 原樣搬 |
| Review 回報的路徑差異 | `## Entrypoints`／`## Flow`／`## Steps` | 補進去 |
| 本次踩到的假設／限制 | `## Invariants and gotchas`／`## Failure modes` | 一句話 |
