# Knowledge 與 retrospective

## 每次任務前的記憶讀取

1. Claude／Codex 只有 UserPromptSubmit：用 payload 的 prompt 與 cwd 依當前任務自動篩選 curated verified 記憶（最多 6 筆、800 字元）。自然語句用英文／中文斷詞後匹配內容；不將 prompt 插入 shell。每次提交都重新篩選，同一 session 已注入的條目不再重複；沒有命中就不注入，也不因為沒命中另外補查。Antigravity 沒有等價的 prompt-submit 事件，才在首次 PreInvocation 提供主題導航作為替代入口。
2. 每次新任務先讀相關記憶；自動 hook 的結果就是預設證據。只有下列情況才由 agent 依完整任務脈絡明確執行 `agent-workflow memory-context --auto --query '<task keywords>' --cwd '<repo>'`：使用者明確說「之前、上次、記得、延續」；prompt 太短或不足以檢索；任務進行到中後段、影響面已改變；或平台沒有 prompt hook（Antigravity）。沒有命中不因此另外補查。Explicit query 維持所有有效關鍵字都要命中的語意；用 2–5 個精準的 topic／symbol 關鍵字，不把整段需求貼成 query。
3. 自動 hook（UserPromptSubmit 與 Antigravity PreInvocation 導航）只掃 curated verified 記憶；只有 explicit query 才唯讀掃描平台原生記憶（Claude 的 `~/.claude/memory`／project memory、Codex 的 `~/.codex/memories`／`memory`、Antigravity 的 `~/.gemini/antigravity/brain`）。這些候選一律標成 `needs_verification`，不能取代 curated verification。`~/.agent-workflow` 是跨平台共用的可寫 curated store；安裝時把同一個絕對 state root 寫入三平台 hooks。記憶只作參考，使用前核對現況；沒有相關結果不以最近更新補足。同一任務重用查詢結果，任務或影響面改變才補查。
4. 摘要不足以判斷時，用 `agent-workflow knowledge --action Search --scope Project --query '<keywords>' --limit 5` 取得 path 並讀全文；查全域偏好時明列 `--scope Global`。未 verified 結果僅作線索。詞彙匹配不是語意搜尋，同義詞／跨語言未命中時改用記憶 topic 的詞彙查詢。
5. Reviewer 可自行搜尋；專案結構與模組流程走 project docs。

## 寫入

- 使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即以 `agent-workflow learn --action Capture` 寫入目前 project；跨專案偏好或通用教訓才寫入 Global。沒有耐久價值時不增加任何步驟。
- 同 topic 由 script 更新既有 entry，相同內容依 content hash 去重。Global knowledge 必須至少有兩個獨立專案證據、經使用者同意，並傳入 `--approved-by-user`。
- 有寫入時在回覆中簡短告知摘要。秘密、token、密碼、連線字串與個資一律不寫入。
- Review 找到的 blocker 若屬於路徑或影響面的認知缺口，且同類修改下次仍會踩到（例如隱藏的第二個入口、共用 table 的另一個寫入者、某目錄完全沒有測試基礎設施），以 `agent-workflow knowledge --action Upsert --scope Project` 寫入，topic 用英文 kebab-case，第一行寫成可獨立理解的摘要並含具體 symbol 或路徑。單次筆誤或單點邏輯錯誤不寫。

## Retrospective

Review 打回的逐輪歸因見 [review.md](review.md)。只有疑似 regression、同一問題反覆修正或使用者要求時，另由主對話做回歸歸因，結果寫入 `## Retrospective result`：查不到引入點就寫 `unknown` 並列出跑過的搜尋，framework change 需指名哪個檔案的哪一條規則要改成什麼。確認 regression 才執行 `agent-workflow review-cause --action Record --cause regression --round <n> --evidence <缺了什麼> --miss-category <impact_surface|execution_path|reviewer_dimension|risk_flag|completion_criteria|test_gap|pre_review_gap|outside_framework|other> --proposed-change <framework 要怎麼改>`；regression 不受 review 輪次限制，`--round` 可以是 1。這是 review-cause 唯一的 structured escalation store，不再另外維護第二份 retro index。
