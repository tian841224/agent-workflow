---
doc_type: decision
covers: ["agent_workflow/skill_draft.py", "agent_workflow/memory_context.py", "agent_workflow/installer.py", ".agents/skills/distill/", ".agents/skills/operational-verification/", "schemas/skill-draft.schema.json"]
---

# 記憶提煉成 skill 草稿（skill-draft）

## Context

參考 Warp 的兩塊機制：已上線的 Skills，以及仍在 research preview 的 Agent Memory「把反覆出現的模式提煉成可供審閱的 skill 草稿」。

Skills 這塊本 repo 已經齊備（`.agents/skills/` 為 canonical source，installer 散佈到三個平台）。缺的是第二塊：記憶只進不出。`learn` 捕捉 → `knowledge` 存放 → `memory_context` 在 SessionStart 注入，沒有任何機制回頭問「同一類結論已經被記了幾次」，重複出現的模式永遠停留在散落的 entry。

`retro.py` 已有「同一 `miss_category` 累積達門檻就 escalate」的先例，本次沿用同一個「重複才升級」的思路。

## Decision

新增 `skill-draft` 指令與 `distill` skill，形成 `Scan → Draft → Promote / Reject` 管線。

三個目錄責任分離：

| 位置 | 內容 | 會被 agent 載入 |
| --- | --- | --- |
| `<state>/projects/<id>/knowledge/entries/`、`<state>/knowledge/global/entries/` | 既有記憶 entry | 否 |
| `<state>/skill-drafts/<name>/` | 待審草稿與 `index.json` | 否 |
| `<state>/skills/<name>/` | 已核准的 skill | 是 |

- **草稿刻意放在所有平台 skill 路徑之外。** 草稿是機器歸納出的指令；一旦落在 `~/.agents/skills/` 或任一平台 skills 目錄，`_ensure_shared_skill_links` 或平台自身掃描就會讓它立即生效，等於讓 agent 自己寫規則給自己遵守。這是本設計唯一的安全論證。
- **Promote 需要 `--approved-by-user`**，比照 `knowledge` Global Upsert 與 `learn` Global scope 的既有護欄。
- **分工沿用 repo 慣例**：runtime 做確定性的分群、去重、暫存、護欄與散佈；agent 寫散文。與 `learn`、`project-doc` 一致。
- **觸發用 SessionStart 提示**，不新增 hook：`memory_context.render_context` 在標頭後、entry 之前插入一行待審數量，位置在前所以不會被字元上限截掉。數量由 `scan_summary` 以 `pending.json` 對 entry 目錄最新 mtime 做快取。
- **Promote 即時散佈**：`installer.ensure_platform_skill_visibility` 依 `managed-runtime.json` 新增的 `targets` 欄位，把已核准 skill 連結到 Claude、複製到 Codex／Antigravity，不必等下次安裝。`_ensure_shared_skill_links` 一併改成接受多個來源根目錄，讓重裝能還原連結，且不會把 state 來源的連結當成孤兒清掉。

### 分群依據

分群跑在 **topic token** 上，不是整篇 entry。實測發現：以 topic + summary 斷詞時，summary 的附帶詞彙（"variant"、"always"）會在互不相關的 entry 間形成一個大群，並把真正的群當成子集吞掉。topic 是 capture 當下刻意命名的主題，訊號乾淨得多。

一度改用「出現比例超過 60% 視為通用詞」來擋這類雜訊，但比例是統計量，在只剩單一叢集的小型 store 上會把唯一的真群也當成通用詞濾掉。改成 topic token 後這個補丁不再需要，已移除。

2026-08-30 首次以累積 244 筆的真實 store 檢驗，topic token 分群本身仍不足，補上三道確定性的過濾（都不是統計量，因此在小型 store 上不會誤殺）：

- **來源限制**：只有 `origin: native` 且 `status: verified` 的 entry 進入分群。實測 store 裡 237 筆是匯入的 rollout summary、7 筆才是 `learn` 捕捉的結論，前者把後者完全淹沒。匯入資料仍留在 store 供 `knowledge Search` 查詢，只是不再驅動提煉。
- **digit-led token 濾除**：topic slug 內的時間戳片段（`2026`、`21t08`）在所有匯入 entry 間共現，形成佔據前兩名的空群。以「開頭是數字」為判準而非「含數字」，是因為隨機 session id（`j6bv`）每筆都不同、本來就不會成群，而版本型主題（`oauth2`）該保留。
- **停用詞表**：只收英文機能詞（`and`、`with`、`from` 等），不收 `code`、`agent` 這類領域高頻詞——後者可能是真主題，交給前兩道過濾與門檻處理。

`existing_skill_match` 同時改掉誤配：原本以單一 cluster token 對「skill 名稱＋描述」的 token 集合做子字串比對，`and` 因此命中 `codebase-design`、`code` 命中 `eli5`，等於告訴 distill「每個群都已經有 skill 覆蓋了」。改為 cluster_id 命中 skill **名稱** token，或 cluster token 與 skill token 交集達 2 個以上。

三項合計把該 store 的候選從 10 組（全部是噪音）降到 1 組（skill 分流規則，4 筆）。

### 摘要抽取

`frontmatter.summary_line` 統一 `memory_context`、`skill_draft`、`knowledge Search` 三處各自複製的實作，並多剝一層巢狀 frontmatter：從其他 store 捕捉來的 entry，內文本身就是一份帶 frontmatter 的檔案，只剝外層會讓摘要變成 `---`（實測 SessionStart 注入有兩筆如此）。巢狀區塊要含 `key: value` 行才會被剝，因此以水平線開頭的正常內文不受影響。`promote` 仍只剝一層，那裡的語意是「去掉草稿自己的 frontmatter」。

## Alternatives

- **核准後的 skill 寫回 repo `.agents/skills/`**：好處是進版控、跟著 review 走；否決，使用者拍板走個人層級的 state 目錄，不污染 repo。
- **在 `close-task` 之後掃描**：抓得最即時，但會讓每次收尾變重；否決，SessionStart 提示成本近乎為零。
- **只做 Scan + Draft，核准與搬移人工處理**：風險最低，但少了 Reject 抑制紀錄，同一組模式每次 session 都會再冒出來；否決。
- **自動 Promote**：直接否決，違背「可供審閱」這個前提。

## Consequences

- 記憶從只進不出，變成有出口：反覆出現的結論能升級成規則，但升級權在使用者手上。
- `memory-context` 每次 session 多一次快取檢查（未變動時為每個 root 一次 `scandir`）；hook 逾時 15 秒，餘裕充足。
- `managed-runtime.json` 新增 `targets` 欄位；舊版安裝沒有這個欄位時，Promote 的散佈會安全地跳過，等下次安裝補上。
- Reject 以「當下 entry sha 集合」抑制，模式要再累積達門檻數量的**新** entry 才會重新浮現，拒絕過的判斷不會每次 session 被重提。
- 掃描結果上限 10 組，避免大型 store 讓 Scan 輸出失控。

## 2026-08-30 follow-up：明確核准的 repo upstream

原決策仍以 `<state>/skills/` 作為 promoted skill 的預設落點，不會自動污染 repo。使用者另行明確要求把 `operational-verification` 同步到 repo，因此將這一個已核准且具跨專案價值的方法納入 `.agents/skills/` canonical source、installer allowlist、managed manifest 與三平台 regression test。

這次 follow-up 建立的是明確核准邊界：只有使用者指定要 upstream 的 skill 才寫回 repo；Promote 本身仍不會自動修改 repo。

## Unverified

- 分群門檻預設 3 次是沿用 `retro` 的「重複才升級」直覺再拉高一級，尚未以長期累積的真實 store 校準。
- topic token 分群在 CJK 主題上以字元 bigram 匹配，未在大量中文 entry 的 store 上驗證過召回率；digit-led 與停用詞過濾都只作用在英數 token，CJK bigram 不受影響。
- 來源限制後，真正參與分群的 entry 數量大幅下降（實測 store 只剩 7 筆），門檻 3 次要多久才會累積到有意義的候選還沒有觀察值。
- `existing_skill_match` 的「交集 2 個 token」是憑實測誤配案例訂的，沒有第二組 store 佐證。
