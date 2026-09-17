---
doc_type: decision
covers: ["agent_workflow/learn.py", "agent_workflow/frontmatter.py", "agent_workflow/knowledge.py", "agent_workflow/topics.py", "schemas/knowledge.schema.json", ".agents/skills/learn/"]
---

# 記憶取代、刪除與衝突偵測

## Context

`learn` 原本只有 Capture，去重只靠 content sha256 全等比對，沒有更新、取代或刪除。結論被後來的判斷推翻時，新舊兩筆都留在 store，而且兩筆都會：

- 佔用 SessionStart 注入的 tier 配額，把已被推翻的結論當成現況交給下一個 session
- 參與 `skill_draft` 分群，讓同一個主題以「重複出現」的姿態推向 distill

實測 store 已經出現這個形狀：2026-08-24 同一天記下的 `correction-skill-routing-and-tdd-boundary` 與 `correction-tdd-code-task-scope`，後者是前者的收斂，但兩筆等價共存。

`schemas/knowledge.schema.json` 的 `relationships` 早就定義了 `supersedes:` 前綴，只是 `learn.py` 一律寫入空陣列——約定存在，實作沒接上。

## Decision

Capture 新增可重複的 `--supersedes <entry id | content sha>`。

- **雙向記錄**：新 entry 的 `relationships` 寫入 `supersedes:<sha>`（沿用既有 schema 約定），舊 entry 改為 `status: superseded` 並補上 `superseded_by: <sha>`。單向指標不夠——讀到舊 entry 的人要能直接看到誰取代了它。
- **軟退場，不刪除**：`superseded` 是第三個 status，不是刪檔。`knowledge --action Search/List --status superseded` 仍查得到，稽核鏈完整；但預設的 `verified` 查詢、SessionStart 注入與 `skill_draft` 分群都不再看到它。三個下游本來就以 status 過濾，因此只有 `memory_context` 需要新增一行跳過。
- **寫入前先解析、寫入後才退場**：`--supersedes` 的目標在任何檔案落地前解析完畢，打錯字讓整次 capture 失敗；退場則在新 entry 落盤之後才執行。兩個順序合起來確保任何中斷點都不會出現「舊的退了、新的沒寫成」。
- **自我取代直接拒絕**：內容相同的重複 capture 會走到既有的 sha 去重路徑，若又指向自己會把唯一的現行版本退場。
- **兩種參照都接受**：Capture 印出的 `id`（檔名）與 frontmatter 的 `content_sha256`。前者是使用者看得到的，後者是 `relationships` 裡實際存的。
- **範圍限定在同一個 store**：只在新 entry 所屬的 project 或 global 目錄內解析。跨 scope 取代需要先回答「專案結論能不能推翻通用結論」，那是另一個決策。

順帶修掉 `learn` 與 `knowledge` 的輸出編碼：兩者原本用 `print(json.dumps(...))`，在 cp950 主控台上輸出中文會壞。`learn` 的 entry id 內嵌 topic slug 而 `_slug` 保留 CJK，`knowledge Search` 的 excerpt 更是直接吐中文內文——而 Search 正是 superseded entry 的讀回路徑，不修就等於取代之後查不回來。改用 `protocol.write_json` 直接寫 UTF-8 bytes，與其他 entrypoint 一致。

`frontmatter.set_field` 是新的共用寫入器，只作用在開頭的 frontmatter 區塊：entry 內文本身可能含 `key: value` 行（匯入的 entry 內文就是一整份帶 frontmatter 的檔案），全檔替換會改到內文。`retro.py` 既有的同名工具作用在 finding 檔上，不在本次範圍內，未合併。

### 推翻的結論刪除，不是退場

使用者拍板：被推翻的決策應該刪除紀錄。原先「一律軟退場」的稽核鏈理由在此不成立——取代必定伴隨一份替代結論，舊的錯誤答案留著只會讓某個未來 session 讀到它並照做。因此區分兩件事：

| 舊 entry 的狀態 | 旗標 | 結果 |
| --- | --- | --- |
| 仍成立，只是被收斂或講得更精確 | `--supersedes` | `status: superseded`，可查、不注入、不分群 |
| 被推翻，現在是錯的 | `--forget`／`--action Forget` | 直接刪檔，不留墓碑 |

刪除是不可逆的使用者資料，因此 `--reason` 必填（獨立 `Forget` 時），且 skill 明寫只有使用者說錯了才刪。同一個 entry 同時出現在兩個旗標一律拒絕——這是呼叫端還沒想清楚，不該由 runtime 猜。

刪檔會讓 `skill_draft` 的 `pending.json` 失效：它的快取鍵是 entry 目錄的最新 mtime，而刪除只會讓最新 mtime 下降，`scanned_at >= newest` 仍然成立，舊計數會存活。因此 `_forget` 明確清掉該快取（`skill_draft` 的 `_invalidate_cache` 因此改名為公開的 `invalidate_scan_cache`）。

### 「該取代卻沒取代」的偵測

原本這是本文件的第一條 Unverified：agent 忘記帶旗標時毫無訊號。補上三層：

1. **Capture 回傳 `related`**：同 store 中 topic 至少共用一個詞的現行 entry。agent 當下還握有脈絡，誤報的代價只是看一眼。
2. **`learn --action Conflicts`**：週期性掃描，把 topic 共用**兩個以上**詞、且未和解的現行 entry 併成群。門檻比 `related` 嚴，因為會叫狼來的清單沒人會看第二次。
3. **SessionStart 提示**：有未和解的群時報數量，與 distill、review-cause 兩個既有提示並列。

**刻意不做成 gate。** 寫入當下無法區分「這是矛盾」與「這是同一類教訓的第二個實例」——後者正是 `skill_draft` 存在的理由，擋掉它等於餓死提煉管線。所以 runtime 只負責找出候選並報數，判斷留給 agent 與使用者。

判斷後以 `--action Keep --id <a> --id <b> --reason <why>` 寫入雙向的 `coexists_with`，該組不再被提報；這比照 `skill_draft` Reject 的抑制設計，避免同一個已拍板的判斷每次 session 重提。

分詞器抽成 `agent_workflow/topics.py`，由 `learn` 的重疊偵測與 `skill_draft` 的分群共用：兩者都在回答「這兩筆是不是同一個主題」，各自斷詞會讓同一組 entry 在一邊算一個主題、另一邊算兩個。

## Alternatives

- **直接改寫舊 entry 的內容**：最省空間，但 store 是 append 語意，改寫會讓「當時記了什麼」不可考；否決。
- **一律軟退場、從不刪除**：本文件初版的決定，被使用者推翻，理由見上。
- **一律刪除、不保留 superseded**：會把「我們把範圍縮小了」的收斂歷史一起丟掉，而那份歷史仍然成立；否決，改為依「推翻 vs 收斂」二分。
- **新增 `--action Supersede` 獨立指令**：多一次呼叫，而取代必定伴隨一次新的 capture，拆成兩步只會製造「記了新的但忘了退舊的」的空窗；否決。
- **由 runtime 自動判斷取代關係**（例如同 topic 就自動退場）：topic slug 相同不代表結論互斥，兩筆可以是互補的細節；否決，交由呼叫端明示。
- **Capture 時強制和解（gate）**：偵測到重疊就要求 `--supersedes`／`--forget`／`--keep` 三選一才放行。否決——同主題重複出現正是 distill 的原料，擋掉會讓提煉永遠沒有輸入。
- **以內文 token 而非 topic 判斷相似**：CJK 以字元 bigram 斷詞，任意兩段中文都會共用大量常見 bigram，內文比對在中文 store 上等於全部命中；否決，改為「topic 為準，並要求 agent 重用既有 topic 措辭」。

## Consequences

- 記憶從只增不減，變成有收斂機制；但收斂是明示的，agent 必須主動判斷「這是取代還是補充」。
- `status` 多一個值，任何未來新增的消費端都必須決定要不要看 `superseded`，預設應為不看。
- 舊 entry 檔案永久保留，store 大小仍然單調成長——這是刻意的取捨，換取稽核鏈完整。
- `learn`、`knowledge` 的 stdout 改為緊湊 JSON（`write_json` 用 `separators=(",", ":")`），既有以 `json.loads` 解析的呼叫端不受影響。

## Consequences（補充）

- 刪除不可逆，且不留紀錄。誤刪只能靠使用者記得，runtime 幫不上忙——這是「推翻就該消失」的直接代價。
- 偵測品質完全繫於 topic 措辭的一致性。同一個主題被取兩個沒有共用詞的 topic 時，三層偵測都不會響。skill 因此把「重用既有 topic 措辭」寫成明確規則。
- `Conflicts` 是 O(n²) 的兩兩比對；244 筆約三萬次集合交集，SessionStart 可接受，數千筆時需要改用倒排索引。

## Unverified

- `Conflicts` 的門檻（共用 2 個 topic 詞）與 `related` 的門檻（1 個）都只在小型 store 上試過，尚不知在數百筆時誤報率如何。
- CJK topic 以字元 bigram 比對，「TDD 適用範圍」與「TDD 範圍適用」這類換序會共用大量 bigram 而視為同主題；目前看是想要的行為，但沒有反例驗證過。
- `superseded` entry 永久保留，長期下來對 `_files` 的 mtime 掃描與 `skill_draft` 的全量讀取是線性成本；目前 store 規模（244 筆）遠未到需要處理的程度。
- 跨 scope 取代（project 結論推翻 global 結論）未支援，也還沒有實例可判斷是否需要。
- `conflict_count` 只看 project scope。global store 目前全是匯入資料（`_live` 已濾掉），等到有原生 global entry 時要重新判斷。
