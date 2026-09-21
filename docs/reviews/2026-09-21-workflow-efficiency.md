# 工作流程效率審查（2026-09-21）

以 HEAD 0fbf3cf 為依據，延續 [2026-09-17 審查](2026-09-17-workflow-efficiency.md)。審查範圍：所有 skill 的描述與內容、三平台 hooks 的內容與觸發時機、managed task 的 CLI 往返與 evidence 記錄。本次只處理有具體證據的問題，沒有新增 command、hook、schema 欄位或抽象層。

## 已完成的優化（本次確認仍成立）

單一 managed_change gate、task-init 一次回傳 plan／procedures／readiness、共用 procedure resolver、project-doc digest reuse、batch evidence、close-task 內含 gate、lazy CLI 與獨立 hook bundle、delta-first review、自動記憶只掃 curated。

最低風險 managed task 只載入一份 procedure（evidence.md）、1 個 evidence id、0 個角色、3 次 CLI 往返；單一 financial flag 就升到 4 份 procedure、14 個 evidence id、6–7 次往返。真實的多 flag task 曾有 48 個 required id，其中 41 筆 attested evidence 在 18 秒內各用一次 CLI 寫入，是最大的可消除重複。

## 本次修正

| 類別 | 問題 | 修正 |
| --- | --- | --- |
| 正確性 | 勾選 Completion criteria 的 checkbox 會改變 intent_hash，使全部 evidence 與 waiver 過期，需重跑驗證 | intentHash 把已勾與未勾視為相同；新增 lifecycle 測試（勾選不影響、改文字仍失效） |
| 正確性 | Stop locale-lint 輸出的 hookSpecificOutput 形狀不是 Stop 契約，且 Claude 的 Stop payload 沒有回覆文字，實務上疑似從未生效 | 改為頂層 decision／reason；沒有文字欄位時讀 transcript 檔尾最後一則 assistant 文字；cli.ts 補傳 --platform；測試同步更新 |
| 可靠性 | Codex 三個 hook 沒有 timeout | 補 15 秒，與其他平台一致 |
| 每 prompt 成本 | UserPromptSubmit 的記憶 hook 每次都 compile ajv，且同 session 重複注入相同 excerpt | ajv 改為首次寫入才 compile；以 session_id 在 OS temp 記已注入紀錄，同 session 不重複注入 |
| 每次工具呼叫成本 | Claude 的 git-guard matcher 為 *，Read／Grep／Glob 也 spawn node | matcher 改為 shell、編輯類與 mcp__.* 的正向清單；MCP 寫檔工具仍全數經過 guard；parity 測試鎖定涵蓋範圍 |
| 每次工具呼叫成本 | 唯讀工具先做 stat 探測才放行 | hookDecision 對無 command 的唯讀工具提前放行（行為等價，Codex／Antigravity 也受益） |
| git 子行程 | projectIdentity 每次呼叫 3 個 git 子行程，一次 evidence-run 重複 2–3 次 | 行程內以 path 為 key 快取 |
| 重複記錄 | evidence.md 同一條結案順序在 6 個文件重複；沒有文件提到 required_evidence，也沒有說 attested step 應批次寫入 | 收斂成 evidence.md 的 Finalization 單一段落，其餘改 pointer；補上 required_evidence 作為工作清單與批次記錄指引 |
| 重複讀取 | 中文回覆需讀 AGENTS、localization-tw SKILL、locale.md 三份幾乎相同的內容，且 AGENTS 兩行互相矛盾 | 刪除 AGENTS 的強制讀取 pointer；localization-tw 的 description 與內容改以翻譯／術語疑義為 trigger；一般回覆依 AGENTS 常駐規則與 Stop hook |
| 描述 | adhd-comms 的 description 沒有 trigger 條件 | 改為使用者要求時使用；manifest 與 README 同步；刪除無程式讀取的 manifest triggers |
| 過時文件 | workflow-runtime.md 仍寫 task-init 後跑 preflight、提到已移除的 validation profile 欄位、covers 指向不存在的檔案；architecture.md 記錯 preflight 位置 | 逐處更正；architecture.md 的 Memory 與 protocol 3 段改為原則加 pointer |
| 噪音 | 舊 task 的 schema 錯誤每筆 evidence 各印一行相同訊息 | schemaErrors 輸出去重 |
| CI tripwire | policy-matrix 漏掉 impact_effect schema、confidence medium 與 4 個 test_integrity facts | 補進取樣維度並重生 fixture（7200 → 12600 列） |
| 小 bug | execution packet 對 undefined managed_change 的預設與 plan 相反；workflowPlan 讀檔在 try 外；taskWrite 忽略 emitOutput；contract-lint 漏掃兩個框架 skill | 各一至三行修正 |

## 需要使用者動作

hooks 與 runtime 是安裝副本，修正要重新 build 並執行 npm run setup 後才對實際 session 生效。Stop hook 契約以本次記憶中的 Claude Code 行為為準，官方文件對欄位的查證結果不一致；安裝後請用一則含「運行」「配置」等詞的中文回覆實測是否被擋一次。

## 仍未解決或刻意保留

- Codex 與 Antigravity 的 guard matcher 維持 *，因為工具名稱未證實；Codex 另有 execpolicy 靜態規則。
- planOutput 的 order 與 selected 內容相同、roles 可由 required_evidence 推得，但都是 CLI 契約欄位，移除只省每次約 100–200 字元，不值得改 schema。
- workflow-policy.json 中 bug_diagnosis 的第一組 suggest 條件被第二組完全涵蓋。不刪：policy 檔案雜湊會進 plan_hash，修改會使進行中 task 的 evidence 失效，而行為沒有差異。
- 單一 risk flag 帶來的 evidence 級距、evidence-run 前後各一次完整 snapshot、delivery-wide freshness：屬安全邊界，成本面已由批次記錄與 projectIdentity 快取處理。
- git-guard 擋直譯器讀 task.json：維持。跨 task 的唯讀彙總可用 jq 或 task-report。
- 沒有取得完整 session 的 token、時間或返工 A/B；本次驗證只確認建置、型別、lint、contract-lint 與全套測試通過，不宣稱總 token 或總時間已量測改善。
