---
name: root-cause
description: "缺陷已修正或 review finding 已確認，或同一類錯誤再次出現時使用；追查缺陷為何可能發生及未被攔截，並補上合適的測試、共用機制、專案文件或規則。"
---

# root-cause

錯誤本身已經找到並修好（找錯誤依 [diagnosing-bugs](../diagnosing-bugs/SKILL.md)）。先判斷起因；起因指向缺文件、缺規範或缺共用機制時，才依 [remedies.md](remedies.md) 把缺口補在目標專案裡。

## 1. 列出問題

從目前對話整理出已確認的錯誤：修好的 bug、review finding、被使用者糾正的做法、重工或 retry。每項寫一行：症狀、修正位置、修正內容。

- 同一個起因造成的多個症狀合併成一項。
- 還沒確認成因或還沒修好的項目標 `unresolved`，只列出，不補救。

## 2. 判斷起因

對每一項追問「寫程式的人（或 agent）當時缺了什麼，才會寫出這個錯」。起因分類與定義以 [review-cause.schema.json](../../../schemas/review-cause.schema.json) 的 `cause_meaning` 為準；下列判準分不出來時讀它。

判斷時用證據回答，不用推測：

- 宣稱 `doc_gap` 前，先查過專案 `docs/`（可用 `agent-workflow project-doc --action Lookup --paths <修正路徑>`）確認真的沒有或已過時。
- 宣稱 `convention_gap` 前，找出至少兩處不同檔案遵守該做法的既有程式作為證據，且不是本次修正改出來的；不足兩處時不歸 `convention_gap`，起因依本清單其餘判準歸類（都不成立時是 `logic_error`）；修正若確立了專案原本沒有的寫法規定，不論歸成哪一類，都依第 3 節那一句往下處理。
- 宣稱 `context_miss` 時，指出本來該讀到的那份文件或規則。
- 宣稱 `prompt_gap` 時，指出任務的目標、範圍或完成條件沒寫到的那條需求。
- 修正或改動弄壞原本正常的行為時，歸為 `regression`。
- 以上都不成立、只是寫錯時，歸為 `logic_error`。
- 每項最後再標一條防線：缺測試、缺文件、缺規範，或 workflow 缺陷。workflow 缺陷是指 workflow 的某一關本來該擋下卻沒擋，要用 `regression` 的 `miss_category`（值見同一份 schema）指出是哪一關。

## 3. 決定是否往下

- **到此結束**：起因是 `logic_error` 或 `regression`、修正時已補上能擋住它的測試，而且同類錯誤沒有在多處重複出現。每項回報一行：症狀、起因、對應的測試；`regression` 加上 `miss_category`。
- **繼續補救**：其餘情況。每項先回報一行起因與證據，再讀 [remedies.md](remedies.md) 選補救、寫入並回報。

修正確立了專案原本沒有的寫法規定時，不在此結束；寫入位置依 [remedies.md](remedies.md) 的 `convention_gap` 範圍分流，是否需要使用者同意依同檔的「依分級寫入」。

在 managed task 的 review 中，第 2 輪起仍未通過的問題（`regression` 不限輪次），另外依 [review.md](../workflow/review.md#結果回填與-freshness) 記錄 review cause。
