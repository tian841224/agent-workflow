---
status: historical
---

# 版本演進

**固定角色與多軌流程 → 情境式 skills → 組合式計畫 → runtime 契約與證據 → 以驗收案例為完成依據。**

| 版本 | 重大改變 | 重點 | 相較上版本的差異與改善 |
| --- | --- | --- | --- |
| v1 | 建立開發流程與護欄 | 導入角色分工、hooks、規格凍結與 TDD，禁止 agent 自行 commit。 | 從單純依賴 agent 自律，提升為有明確角色、規格與操作邊界的流程；降低未經檢查直接交付的風險。 |
| v2 | 支援跨平台共用 | 從 Claude Code 擴展至 Codex、Antigravity，以 `.agents/` 統一維護共用規則與 skills。 | 從單一平台設定改為 canonical source 加 adapter；規則只需維護一份，減少三平台內容分歧。 |
| v3 | 從固定流程改為按需組合 | 由多軌流程轉向情境式 skills 與組合式計畫，依任務風險選取必要能力與品質步驟。 | 從每個任務套用同一條完整 pipeline，改為小任務少走不必要步驟，複雜任務仍保留必要控管。 |
| v4 | 將流程判定移入 runtime | 由 runtime 管理任務狀態、計畫與完成條件。 | 統一跨平台入口並降低環境差異。 |
| v5 | 明確化任務與驗證契約 | 統一分流入口，並以 task schema 與 runtime receipt 記錄驗證。 | 從以文字描述「已完成」改為可追蹤誰在何時以哪個工作樹與命令完成驗證，並拒絕 stale evidence。 |
| v5 → v6 | 精簡角色與技能 | Skills 分為必裝與選用，減少固定角色交接，僅在需要時啟動獨立審查。 | 從固定 Reviewer／Verifier／Retrospective 角色改為依計畫啟動責任；降低交接與 token 成本，同時保留高風險任務的獨立審查。 |
| v6 | 累積跨平台記憶 | 加入共用記憶與提煉機制，將可重用結論整理為待審 skill 草稿。 | 從每次任務重新摸索，改為可查詢且有範圍的 knowledge；草稿須經使用者核准才會生效，避免未驗證經驗污染流程。 |
| v7 | 統一驗證並降低重複成本 | 整合 hooks、前置檢查、最終驗證與結案路徑，保留切片局部回饋，減少重複確認與不必要的文件載入。 | 從多個角色各自重跑檢查，改為共用 impact map、delivery fingerprint 與單一結案 gate；在維持 verification integrity 的前提下縮短往返。 |
| v7.1 | 以驗收案例為完成依據 | 開發前寫 Given／When／Then 驗收案例，由 runtime 逐條執行；分析步驟改為 checklist；指令輸出附 `next`；程式修改一律獨立 Review，第二輪起只審變動範圍；`task-init --paths` 帶出相關文件、記憶與歷程；記憶加上 tags 與 paths。 | 從 agent 逐條自述的 evidence 改為可執行的驗收；policy 修改不再讓進行中 task 的驗證失效；移除任務狀態檔的 guard 與三個重複的記錄／診斷指令，減少往返與誤擋。 |
| v7.2 | 平行開發交給平台原生 subagent | 實作前由 agent 判斷工作能否獨立完成，適合時直接指派目標、責任範圍與驗收條件，主 agent 整合後執行全部驗收；Git 操作改由入口規則要求使用者授權，不再安裝 Git guard hook。 | 平行開發不再需要固定的 orchestration 流程、packet 或獨立 worktree；Protocol 3 CLI 只保留相容性。 |
| v7.3 | Claude 主對話改為派工與驗證 | Claude 依工作類型把讀取、規劃、實作、複審派給指定模型的 subagent；`CLAUDE.md` 改為引入共用入口與 Claude 專屬派工規則。 | 主對話的 context 不再承載讀檔與實作過程；各平台自己的規則（Claude 派工規則、Codex coordinator 指示、Antigravity 派工規則）只安裝在該平台目錄，不影響其他平台。各平台入口檔 managed 區塊以外的內容各自保留，不會複製到其他平台。 |
| v7.4 | 主對話改回單一 agent loop | 三平台的主對話自己完成讀取、規劃、實作與驗證，只有互不相依且各自要讀寫多個檔案的工作、會擠滿主對話的大量讀取與獨立 Review 才派 subagent；判斷規則集中在 `AGENTS.md` 的「Subagent」段落，平台規則只決定 agent 與模型。移除 Codex 的強制委派 gate 與 planner 角色，task schema 升為 v7 並清除執行平台與 Codex 委派紀錄兩個欄位。 | 規劃與執行由同一個 agent 負責，能依中途結果修正；省下交接造成的細節遺失與等待時間。Codex task 不再因為沒有委派紀錄而無法結案。 |

[回到首頁](../README.md)
