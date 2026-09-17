---
doc_type: decision
covers: ["agent_workflow/review_cause.py", "agent_workflow/task_gate.py", "schemas/review-cause.schema.json", "templates/task.md"]
---

# Review 歸因與補救路由（review-cause）

## Context

[前一階段](2026-08-29-skill-distillation.md)做的是「記憶裡重複出現的結論 → skill 草稿」。使用者要的是另一條線：**從每一次 review 打回與修正中分析原因**，判斷是當初缺文件、還是任務描述不夠細，再把原因回推成規範。

`retro.py` 與 `## Retrospective result` 已經在做「歸因 + 累積 + 達門檻升級」，但問錯了問題也接錯了線：

- 只在疑似 regression、反覆修正或使用者要求時才啟動，一般 review 打回不留紀錄，資料累積不起來。
- `miss_category` 問的是「框架哪一道關卡沒攔住」，沒有「輸入品質」這個軸。
- 累積出來的 finding 沒有任何出口。

## Decision

新增 `review-cause` 指令與 `<state>/review-causes/` 儲存區，形成「每輪記錄 → 依 cause 累積 → 達門檻路由到對應補救」。

### 記錄時機

`## Review round` 的 `round` 遞增本來就代表「上一輪有 blocker」，直接沿用這個既有訊號，不新增判斷。`round >= 2` 時 `task_gate` 要求該輪填 `- cause:`，值是 `review-cause --action Record` 回傳的 id，或 `none - <理由>`。

### 分類與路由

`cause` 是獨立於 `miss_category` 的新欄位，兩者問不同軸——輸入哪裡不足 vs 框架哪關沒攔——混在一起會互相排擠。

| cause | remedy_kind |
| --- | --- |
| `doc_gap` | `project_doc` |
| `prompt_gap` | `task_spec` |
| `convention_gap` | `skill` |
| `context_miss` | `skill` |
| `logic_error` | `none` |

`logic_error` 這個出口是必要的：沒有「不是輸入問題」這一格，每次 blocker 都會被硬塞進某個 cause，累積數就失去意義。`retro` 的 `outside_framework` 扮演同一個角色。路由表與門檻寫在 `schemas/review-cause.schema.json` 的 `x_agent_workflow`，程式碼一律回讀該檔，避免出現第二份權威。

`doc_gap` 這組在 `Escalate` 時額外呼叫 `project_doc.run("Lookup")`，用回傳的 `uncovered` 直接指名真正沒有文件覆蓋的路徑——把「缺文件」變成一個具體要寫的檔案，這正是把它路由到這裡的目的。

### 不與 retro 合併

觸發條件、提問方向與生命週期三者都不同。合併會讓累積計數失去意義：一次 regression 和一次缺文件不是「同一種事情發生兩次」。`retro.py` 與 `retro.schema.json` 完全未動。

### 補救不需要新機制

`project_doc` 走既有的 `project-docs` skill；`skill` 走既有的 `skill-draft` Draft／Promote；`task_spec` 是 `templates/task.md` 或 `AGENTS.md` 的一般 repo 修改，且 `.agents/` 的寫入已由 `skill_guard.py` 攔一次。新增的只有「記錄 → 累積 → 路由」這段，三種補救一律需使用者核准。

`distill` skill 擴成單一提煉出口，兩個來源共用同一套「累積 → 審閱 → 核准」的收尾，避免第二個近乎重複的 skill。

## Alternatives

- **擴充 `retro.py` 的 `miss_category`**：改動最小，但一筆紀錄只能選一個值，「沒文件」和「reviewer 沒攔到」同時成立時要二選一；且會讓 retro 的累積數混入非 regression 事件。否決。
- **每次 review 都記（含 PASS）**：能算出「哪種任務特別容易出錯」的比例，但大部分紀錄是空的，雜訊蓋過訊號。否決。
- **維持只在 regression 時歸因**：成本最低，但單次就修掉的問題不留紀錄，模式要很久才浮得出來，等於沒解決原始問題。否決。

## Consequences

- Review 打回從「修好就算了」變成留下可累積的原因；同一種缺失累積三次就會指名一個具體補救。
- 每輪 review 收尾多一個 Record 步驟，`round >= 2` 的 task 多一個 gate 檢查。
- `evidence` 同時存進 index 與 finding 檔：`Escalate` 只讀 index，若不存在 index 裡，路由結果就沒有可據以撰寫補救的內容。
- SessionStart 提示現在有兩行（記憶模式、review 歸因），都排在 entry 之前，不會被字元上限截掉。
- `escalated_count` 只讀一個 `index.json`，不需要 `skill_draft` 那種 mtime 快取。

## Unverified

- 門檻 3 次是沿用 `skill-draft` 的直覺值，尚未以真實累積的 review 紀錄校準。
- 五種 cause 的分界在實際使用中是否夠清楚（特別是 `convention_gap` 與 `context_miss`）尚未驗證；分不清時的實際行為會偏向哪一邊，要累積一段時間才看得出來。
