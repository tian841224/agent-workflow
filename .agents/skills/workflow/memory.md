# Knowledge 與 retrospective

任務依賴歷史脈絡、使用者要求或已知回歸時才讀本檔；簡單、局部且不依賴歷史的修改略過。

## 查詢

1. 以 2–5 個關鍵字執行 `agent-workflow knowledge --action Search --query '<keywords>' --limit 5`。Query 用小寫英文單字、空白分隔（topic 是英文 kebab-case，中文與整串連字號的命中率極低）。
2. Search 只回傳 entry 第一行前 180 字，命中後要讀 `path` 全文。
3. Managed hook 會執行 `memory-context --auto`：Claude／Codex 在 `SessionStart`，Antigravity 在 `PreInvocation`。自動模式必須先有可用來判斷任務關聯性的 query；沒有有效 query 時直接回空，而且不得 fallback 到同 project 或最近更新的記憶。即使有 query，也只有所有有效關鍵字都命中的 verified memory 才能注入；沒有相關結果就是 0 筆。
4. `--auto` 的 0 筆結果不是錯誤，也不要用降低 threshold、減少 Top-K 或改用 recency 補結果。任務真的需要歷史脈絡時，由 agent 依第 1 點用當前任務關鍵字明確 Search。
5. `needs_verification` 或可能過時的記憶只當線索，使用前回查目前程式、文件或設定。
6. Reviewer 可自行執行 Search 建立脈絡。
7. 專案結構與模組流程不走 knowledge，改走 project docs（見 [project-docs skill](../project-docs/SKILL.md)）。

## 寫入

- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即以 `agent-workflow learn --action Capture` 寫入目前 project；跨專案偏好或通用教訓才寫入 Global。沒有耐久價值時不增加任何步驟。
- 同 topic 由 script 更新既有 entry，相同內容依 content hash 去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `--approved-by-user`。
- 有寫入時在回覆中簡短告知摘要。秘密、token、密碼、連線字串與個資一律不寫入。
- Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `agent-workflow knowledge --action Upsert --scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑。單次筆誤或單點邏輯錯誤不寫。

## Retrospective

Review 打回的逐輪歸因見 [review.md](review.md)。只有疑似 regression、同一問題反覆修正或使用者要求時，另由主對話做回歸歸因，結果寫入 `## Retrospective result`：查不到引入點就寫 `unknown` 並列出跑過的搜尋，framework change 需指名哪個檔案的哪一條規則要改成什麼。確認 regression 才執行 `agent-workflow retro --action Record`。
