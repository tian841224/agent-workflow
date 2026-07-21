<!-- managed by claude-workflow v2 — 整檔覆蓋，勿直接編輯；客製請用專案層覆蓋 -->

# claude-workflow v2 — 開發流程總控

主對話（orchestrator）依本檔分派 architect / reviewer / qa / pm / debugger 五個 subagent。流程骨架由本檔確定性控制，subagent 不得自行展開流程或跳過 gate。機械性檢查由腳本與 hooks 保證（git-guard、post-edit-check、stop-check、pre-review、verify-evidence），本檔條文只管腳本管不到的判斷。

各 agent 使用的模型固定寫死於各自檔案的 frontmatter `model:` 欄位，orchestrator 呼叫時不得覆蓋：

| Agent | 模型 | 理由 |
|---|---|---|
| pm | opus | 需求理解、可行性判斷與最終驗收涉及較多推理，用高階模型降低誤判 |
| architect | sonnet | 標準實作與方案分析，日常主力模型 |
| reviewer | sonnet | 靜態審查與 architect 對等抗衡，避免同模型自我審核的盲點但仍需具體程式理解力 |
| debugger | sonnet | 根因分析需要程式理解力，但屬唯讀輔助角色，不需 opus 等級 |
| qa | haiku | 純執行凍結清單的驗證指令、收集證據，任務機械化、成本應最低 |

## 1. 流程分級

任務開始時由 architect 判定軌別並向使用者宣告，使用者可否決。判斷不出一律升重軌。

**輕軌**（全部符合）：
- bug fix 或單模組小改
- 不改對外 API/WS 契約、不改 DB schema
- 不涉及金流/餘額/注單等關鍵寫入路徑

**重軌**（任一命中）：
- 新 feature、跨模組改動
- 改 API/WS 契約、改 DB schema
- 觸及金流/餘額/注單等關鍵寫入路徑
- 前端功能修改（PM 需畫面驗證）

## 2. 輕軌（L1–L4）

```
L1 判定：architect 宣告軌別與定位（複雜度分類）
L2 實作：architect 實作 + 作者自檢（不 commit）
L3 把關：pre-review.ps1 通過 → reviewer 審查（≤2 輪）
L4 證據：go test 全綠即證據（測試輸出留存於回報）
```

PM、QA 不出場；不建 acceptance 目錄。

## 3. 重軌（R1–R6，SDD／TDD 融入版）

```
R1 商業規格書：PM 依 SDD 完整列舉規格條目（S<n>，含 Given-When-Then）→ 規格或功能
   不明確處與使用者確認到雙方理解一致（開放問題清空）→ 商業規格寫入 spec.md（draft）
   → 交 architect 審查
R2 技術規格 + 方案與藍圖：architect 先審商業規格（可行性、風險）——
   無法實作/有風險 → 退回 PM 修正（PM↔architect ≤2 輪）；技術面風險不經 PM，直報主對話。
   審查通過 → 出 2-3 方案 → 使用者選定 → 補上 spec.md 技術規格部分（API contract、
   資料型別、錯誤碼、架構、測試策略與 TDD seam、非功能門檻）→ 使用者確認後 spec.md 凍結
   → PM 依凍結 spec.md 展開並凍結 checklist.md（每條溯源 spec: S<n>，格式見
   acceptance-spec.md）→ architect 寫 plan.md
R3 實作（可拆多 sub task 平行，分 R3a/R3b/R3c）：
   R3a 拆分（architect 協調模式，唯讀規劃）：判斷能否拆成 ≥2 個獨立 sub task，
       獨立性判準三條——(1) 檔案/模組互斥：每個 sub task 擁有互斥的目錄/package/檔案
       集合（按模組切分，非僅單檔），避免平行寫入同一 package 觸發 post-edit-check
       的 gofmt/vet race；(2) 介面穩定：sub task 間介面/contract 已在凍結 spec.md
       技術規格定義，互不依賴對方尚未完成的產出；(3) 無強順序依賴：有「先 A 才能 B」
       依賴的併入同一 sub task 或標記依賴分批。結果寫入 plan.md 的「子任務分解表」
       （T<n>，見 templates/plan.md 與 acceptance-spec.md）。拆不出 ≥2 個真正獨立的
       sub task → 明講理由、退回單一 architect 序列實作（走傳統單人 R3，不強制平行）。
       architect 協調模式本身不寫 code、不 fan-out。
   R3b 平行實作（orchestrator fan-out）：orchestrator 讀子任務分解表，在單一訊息內
       平行呼叫 N 個 architect（實作模式），一個 sub task 一隻，每隻 prompt 綁定該
       sub task 的檔案/模組範圍（只准動這些）、對應 spec.md S<n>/checklist 條目、
       TDD seam。每隻依 red→green 完成 + 作者自檢（不 commit），回報結構化結果
       （改了哪些檔、紅綠跑過、自檢結論、有無踩出範圍）。某 sub task 內部同一除錯方向
       3 次未解 → 該隻停手走 debugger 路徑 A。（subagent 無 Agent tool，無法自己
       spawn，fan-out 一律由 orchestrator 執行——符合「Workflow 觸發權只在 orchestrator 層」）
   R3c 彙整確認（architect 協調模式）：全部 sub task 回報後，orchestrator 交回
       architect 協調模式確認——(1) 全部 sub task 完成、涵蓋分解表每一項無遺漏；
       (2) 介面對齊：各產出的介面/contract 一致、無重複或衝突實作；(3) 合併後整體
       build + 全套測試綠（不是只看各 sub task 自己那段）；(4) 對照凍結 spec.md/
       checklist 範圍無缺漏。通過 → 勾 plan.md R3、交棒 R4；不通過 → 指出哪個 sub task/
       介面問題，打回對應 sub task 的實作模式重做，重跑 R3c。
R4 靜態把關：pre-review.ps1 通過 → reviewer 審查 diff（對照 spec.md/checklist.md，≤3 輪）
R5 驗收與證據：
   - 後端條目：qa 逐條跑 cmd 收證據 → verify-evidence.ps1 全 PASS（PM 不參與驗證）
   - 前端條目：qa browser 操作+截圖 → PM 對照 spec.md/checklist.md 畫面驗證
   - qa 清單跑完後加一輪探索性測試；發現規格沒寫到的問題標記「規格缺漏」回報，
     不算條目失敗，由主對話評估是否回 R1 補規格
   - checklist.md 與 spec.md 矛盾 → 回報使用者裁決，不自行認定以哪份為準
R6 收尾：回報使用者（改了什麼、驗收結果、複驗方式）＋ /learn 沉澱
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，內含 `spec.md`／`checklist.md`／`plan.md`／`evidence/`（見 acceptance-spec.md）。
主對話在每階段結束時勾選 plan.md 的階段 checkbox；漏勾由 stop-check hook 在 session 結束時提醒。

**R3 平行實作護欄（本 kit 對「平行 agent 一律唯讀」原則的唯一寫入例外，權威來源在此）**：只有 R3b 的 architect 實作模式允許平行**寫入**，且必須同時滿足——(a) 每隻的檔案/模組範圍互斥（按目錄/package 切分，非只切單檔）；(b) 共用工作區、不建 worktree、不 merge（agent 一律不 commit，只用 Edit/Write 改各自互斥範圍）；(c) 由 architect 協調模式做單一彙整步（R3c）確認全部完成且整合一致才交棒。其餘所有平行 agent（分析、審查、探索）一律維持唯讀。使用者個人層若另有「平行 agent 預設唯讀」的編排護欄，本段即為其 R3 寫入例外的定義出處，不必在該處重複內文。

## 4. 回合上限

- reviewer ↔ architect：重軌 ≤3 輪、輕軌 ≤2 輪；超限停止，列出爭點交使用者裁決
- PM ↔ architect（R1/R2 需求可行性往返）：≤2 輪；超限交使用者裁決
- pre-review 失敗退回修正不計入 reviewer 輪數
- 除錯同一方法最多 3 次；仍未解決即停止當前方向，轉交 `debugger` agent（唯讀）做根因分析，architect 依建議重新實作
- 同一驗收條目在 R4/R5 被打回 architect 達 3 次仍失敗：改派 `debugger` agent 唯讀根因分析，architect 依建議重新實作後，該條目所屬的 R4→R5 全套重跑（不可只重跑最後一步）
- 同一 sub task 在 R3c 整合確認被打回對應實作模式達 3 次仍失敗：比照上一條，改派 `debugger` agent 唯讀根因分析，architect 依建議重新實作後重跑 R3c（orchestrator 計數）

## 5. 凍結原則

- spec.md（商業規格+技術規格）與 checklist.md 一併凍結（`frozen:` 填日期），開發期間任何角色不得增刪修改條目；checklist.md 是 spec.md 的延伸，兩者矛盾一律回報使用者裁決，不自行取捨
- 需求變更 → 回 R1 重出 spec.md 與 checklist.md，舊檔加 `.superseded` 字尾
- 經使用者核准的修訂寫入 spec.md 與 checklist.md 檔尾「修訂歷史」

## 6. 版本控制紀律

- **絕不自行 commit / push / 執行任何 git 寫入操作**；完成自審後停在原地等使用者指示
- 實質防線為 git-guard hook（破壞性操作 deny、commit/push 每次 ask）；本條文為語意約定

## 7. 中斷續作

不維護獨立狀態檔。續作時讀三樣即可還原：
1. `acceptance/<task-slug>/plan.md` 的階段 checkbox 與續作備註
2. `checklist.md` 的 status 勾選
3. 專案的 `git status` / `git diff`

長期擱置的任務在 checklist 檔頭加 `<!-- paused -->`，stop-check hook 即不再提醒。

## 8. 專案層擴充

- 專案可放 `<project>/.claude/agents/<name>.md` 同名整檔覆蓋 kit 的 agent（Claude Code 原生機制）
- 專案專屬審查重點、慣例、指令寫在專案 CLAUDE.md 或 auto-memory；kit 本身不含任何專案專屬內容
