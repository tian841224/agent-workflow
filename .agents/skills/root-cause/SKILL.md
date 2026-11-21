---
name: root-cause
description: "確認 bug、review finding 或影響正確性的錯誤做法時使用；先依證據歸因，修正驗證後確認防線是否足夠。"
---

# root-cause

本 skill 回答：**這個錯為什麼寫得出來、為什麼沒被擋下**。缺陷或錯誤做法已確認即可開始歸因；修正並驗證原始症狀消失後，再判斷防線是否足夠。成因尚不明確時依 [diagnosing-bugs](../diagnosing-bugs/SKILL.md) 建立證據。

使用者指出影響正確性、契約或反覆發生的錯誤做法，也依本流程處理。一般表達偏好交給 [learn](../learn/SKILL.md) 判斷是否保存；外部服務暫時失敗、重工或 retry 本身不構成缺陷證據。

## 1. 列出問題

整理本次已確認的 bug、review finding 或錯誤做法。每項寫一行：症狀、依據、受影響位置、修正狀態。

- 同一個起因造成的多個症狀合併成一項。
- 成因尚未確認的項目標 `unresolved`，列出下一個診斷動作，不把猜測寫成歸因。
- 成因已確認但尚未修正或驗證的項目，可以記錄成因與預計補救；狀態標為待修正或待驗證，不宣稱防線已完成。

## 2. 判斷起因

對每一項追問「寫程式的人（或 agent）當時缺了什麼，才會寫出這個錯」。起因分類與定義以 [review-cause.schema.json](../../../schemas/review-cause.schema.json) 的 `cause_meaning` 為準；下列判準分不出來時讀它。

判斷時用證據回答，不用推測：

- 宣稱 `doc_gap` 前，先查過專案 `docs/`（可用 `agent-workflow project-doc --action Lookup --paths <修正路徑>`）確認真的沒有或已過時。
- 宣稱 `convention_gap` 前，找出專案裡遵守這個慣例的既有程式作為證據。
- 宣稱 `context_miss` 時，指出本來該讀到的那份文件或規則。
- 宣稱 `prompt_gap` 時，指出任務的目標、範圍或完成條件沒寫到的那條需求。
- 修正或改動弄壞原本正常的行為時，歸為 `regression`。
- 以上都不成立、只是寫錯時，歸為 `logic_error`。
- 每項最後再標一條防線：缺測試、缺文件、缺規範，或 workflow 缺陷。workflow 缺陷是指 workflow 的某一關本來該擋下卻沒擋，要用 `regression` 的 `miss_category`（值見同一份 schema）指出是哪一關。

## 3. 決定是否往下

- **等待修正驗證**：尚未確認原始症狀已消失時，先完成修正與原始重現案例的驗證；其餘停止條件在驗證後判斷。
- **到此結束**：起因是 `logic_error` 或 `regression`、已有能擋住它的測試且修正後驗證通過，而且同類錯誤沒有在多處重複出現。每項回報一行：症狀、起因、對應的測試；`regression` 加上 `miss_category`。
- **繼續補救**：其餘情況。每項先回報一行起因與證據，再讀 [remedies.md](remedies.md) 選補救、寫入並回報。

在 managed task 的 review 中發現的問題，另外依 [review.md](../workflow/review.md#結果回填與-freshness) 記錄 review cause，讓 distill 能計算同類問題的次數。
