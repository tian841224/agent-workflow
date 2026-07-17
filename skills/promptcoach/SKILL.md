---
name: promptcoach
description: 比對使用者原始 prompt 與最終執行結果的落差，直接給出修正後的 prompt 成品（同時內建一次到位／精準化／省 token），並附簡短落差診斷。當使用者說「檢討這個 prompt」「/promptcoach」「這次結果跟我要的有落差幫我看 prompt」或要求整批檢討 prompt 習慣時使用。適用所有專案。
---

# Prompt Coach — 使用者 Prompt 教練（全域）

依 `~/.claude/rules/prompt-coaching.md` 的定義，教練使用者本人的 prompt 撰寫習慣（與教練 AI 自己的 `learning.md` 自我學習迴圈完全獨立）。

## 步驟

1. **讀規則**：讀 `~/.claude/rules/prompt-coaching.md`（§4 輸出格式、§5 儲存格式、§6 批次檢討、§7 誠實邊界）。
2. **判斷模式**：使用者是要「檢討這一次」（單一 case）還是「檢討我的 prompt 習慣」（整批 inbox）。

### 單一 case 模式

3. **取得目標**：預設分析本次對話中相關的原始使用者 prompt；若使用者指定其他訊息或過去任務，用 ToolSearch 載入 `mcp__ccd_session_mgmt__search_session_transcripts`/`list_sessions`/`get_session` 查找對應 session 內容。
4. **取得最終結果**：實際的檔案變更、最終回覆內容、過程中使用者做過的修正/追問/否決（這些本身就是落差訊號）。任務仍在進行中、結果尚未定案時，先告知使用者「此分析僅供參考」再繼續。
5. **輸出**（依規則檔 §4，主從兩段，不得顛倒順序或拆成三份平行建議清單）：
   1. 修正後 prompt（直接給成品，可複製貼上使用，同時內建一次到位＋精準化＋省 token）。
   2. 簡短落差診斷（原本哪裡模糊/缺漏/隱含假設；只有值得記住的技巧才多補一句）。
6. **記錄**：把這次 case append 一行到 `~/.claude/memory/prompt-coach/inbox.md`（§5.1 格式），除非這次事件先前已被自動輕量捕捉過（避免重複記錄同一件事）。
7. **重複模式偵測**：若這次落差類型在 inbox／`patterns.md` 已出現同類型 ≥2 次，在回報中明講「這是你重複出現的 prompt 習慣」，並直接蒸餾一條進 `patterns.md`（§5.2 格式，查重後合併或新增）。

### 整批檢討模式

3. **讀取全貌**：讀 `~/.claude/memory/prompt-coach/{inbox.md,patterns.md}`。
4. **蒸餾**：找出重複出現的落差類型（同類型 ≥2 次），依 §5.2 格式寫入 `patterns.md`（查重、可合併就合併）；已蒸餾的 inbox 條目移除，inbox 恢復為「（目前無未處理條目）」。
5. **修剪**：`patterns.md` 逼近 30 條上限時，先確認舊條目是否仍成立（依規則檔 §6），過時的刪除。更新表頭「上次蒸餾」「上次回顧」「條目數」。
6. **輸出報告**：這次蒸餾了幾條、合併幾條、找到哪些重複的 prompt 慣性問題，以及每個慣性問題對應的通用改法。

## 注意

- 修正後 prompt 一律放在回報最前面，直接給成品；診斷與技巧是輔助說明，不可反客為主。
- 條目不得包含秘密；prompt 原文含敏感值時用佔位符取代。
- 不主動 commit——`~/.claude/memory/` 不進版控，不需要提交。
