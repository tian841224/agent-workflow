---
name: project-docs
description: 修改 application source code 前載入；先以 project-doc Lookup 查出涵蓋本次路徑的文件並讀過再動手，改完後依查詢結果建立缺少的文件或更新已失準的內容。定義目標 repo `docs/` 的佈局、各 doc_type 的必要區塊與 staleness 判斷。
---

# Project Docs

目標 repo 的 `docs/`，回答「這塊 code 是什麼、流程怎麼走、為什麼這樣決定」。跨 task、跨 repo 的框架級教訓走 knowledge／retro，不走這裡。

## 1. 動手前：Lookup

```text
agent-workflow project-doc --action Lookup --paths '<本次要動的路徑>'
```

回傳命中的文件、永遠附帶的總覽文件（`architecture`／`structure`／`dataflow`／`glossary`），以及 `uncovered`。讀命中的文件建立脈絡；文件與現況程式不一致時以程式為準，並把差異列入下一步要修的內容。

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

## 3. doc_type 路由

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

要建立或改寫某個 doc_type 的內容時，才讀 [doc-types.md](references/doc-types.md)（各型別的必要區塊、記什麼與不記什麼）。

## 4. 其他 `project-doc` action

```text
agent-workflow project-doc --action List                              # 全部文件
agent-workflow project-doc --action Stale                             # covers 路徑比文件本身更新的文件
agent-workflow project-doc --action Check --doc docs/structure.md     # frontmatter／covers／必要區塊
```

`Stale` 只回報一種情況：涵蓋路徑最後一次提交的時間晚於文件本身最後一次提交的時間。判斷完全來自版本歷史比較，不可能被手動改假；未提交的改動與未進版控的新文件都不會出現在結果中。結果只當線索，一律以現況程式為準。

## 5. 在 workflow task 內

`## Project docs` 的 `updated:` 一律要填：本次建立或更新的文件路徑，沒有文件要動就寫 `none - <具體理由>`。Elevated task 另有 `- read:`，填動手前 Lookup 命中並讀過的文件路徑。從 task 既有欄位收割內容的對照表見 [doc-types.md](references/doc-types.md)。
