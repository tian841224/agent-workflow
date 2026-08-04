# 重軌（R1–R6，SDD／TDD 融入版）

適用：波及多個功能、修改既有對外契約/DB schema、或觸及高風險關鍵寫入路徑（判準見 SKILL.md）。

```
R1 商業規格書：PM 先讀專案既有文件與現況行為當 baseline，依 SDD 完整列舉規格條目
   （S<n>，含 Given-When-Then；約 10–12 條以上主動建議拆分任務）→ 不明確處與使用者
   確認到雙方理解一致（開放問題清空，不得用「照既有行為 1:1」自行填答案）
   → 商業規格寫入 spec.md（draft）→ 交 architect 審查
R2 技術規格＋方案與藍圖：architect 先審商業規格——逐條 S<n> 依六維度檢查（規格品質/
   架構相容性/影響面/技術風險/可測性/前置條件與規模，附讀檔查證依據，細節見
   agents/architect.md）→ 需調整退回 PM（≤2 輪）；技術風險不經 PM，直接向使用者裁決。
   通過後平行展開兩件互不依賴的工作：
   (a) PM（續用 R1 同一隻，SendMessage 接續，不重新 spawn）依商業規格展開
       checklist.md draft 驗收條目（溯源 spec: S<n>、G-W-T、
       test-type，涵蓋邊界/等價類/異常路徑，不填 cmd/expect）
   (b) architect 出 2–3 方案（解法明顯唯一、無 trade-off 時說明理由後可單方案徑行）
   → 使用者選定方案 → architect 補 spec.md 技術規格（API contract、資料型別、錯誤碼、
   架構、測試策略與 TDD seam、非功能門檻）→ 依技術規格逐條補 checklist 的 cmd/expect
   （前端條目 type: ui + steps/expect；只補驗證手段，不增刪改 PM 的條目與 G-W-T）
   → 附導讀摘要（條目數、關鍵取捨、與現有行為差異、需使用者裁決的點）送使用者
   一次確認，spec.md 與 checklist.md 同時凍結 → architect 寫 plan.md
R3 實作：預設單人序列——architect 依凍結 spec 的 TDD seam 走 red→green，一次一個
   切片，完成後對照 spec/checklist 自檢（不 commit）。
   平行為例外，四判準全數成立才拆（R3a→R3b→R3c）：
   R3a 拆分：(1) 檔案/模組互斥（按目錄/package 切分）(2) 介面已在凍結 spec 定義
       (3) 無強順序依賴 (4) 規模門檻——每個 sub task 是有份量的獨立工作。
       結果寫入 plan.md 子任務分解表（T<n>，溯源 checklist/S<n>）
   R3b 平行實作：orchestrator 單一訊息 fan-out N 個 architect，每隻綁定互斥範圍、
       對應條目與 seam，red→green＋自檢後結構化回報（Codex 退化為序列逐一完成）
   R3c 彙整確認：全部涵蓋分解表無遺漏、介面對齊無重複/衝突、整體 build＋全套測試綠、
       對照凍結 spec/checklist 無缺漏，才進 R4；不通過打回對應 sub task 重做
R4 靜態把關：pre-review 通過（跳過語言檢查時 reviewer 先人工補跑 build/test）
   → reviewer 審查 diff（對照 spec.md/checklist.md，≤3 輪）
R5 驗收：
   - 後端條目：qa 逐條執行 cmd、當場比對 expect 判定 PASS/FAIL（不落地證據檔）
   - 前端條目：qa browser 操作觀察畫面並判定，qa 判定即為結果；模糊項（畫面與
     expect 有落差）由主對話整理交使用者裁決，PM 不參與驗收
   - qa 清單跑完後加探索性測試（以主動找 bug 為目標，一輪為預算，有發現可加一輪）：
     前端做畫面探索、純後端做 edge-case 探索
   - 探索發現分兩類：規格缺漏（規格沒定義）→ 回報、不算條目失敗，評估是否回 R1；
     實作缺陷（規格已定義但沒做對）→ 視同對應條目一次 FAIL
   - FAIL 處理（批次）：qa 跑完整份清單後彙總該輪全部 FAIL，打回 architect 一批修正
     → 該批修正 diff 過一次 pre-review＋一次 reviewer 輕量複審（只審修正範圍）
     → qa 只重驗 FAIL 條目與修正明顯波及的已過條目，不逐條 FAIL 各跑一圈；
     同一條目累計 3 次仍失敗 → 轉 debugger
   - checklist 與 spec 矛盾 → 交使用者裁決
R6 收尾：回報使用者（改了什麼、驗收結果、複驗方式、流程統計——reviewer 輪數、
   打回次數、有無動用 debugger）＋ know-how 沉澱三問（見 SKILL.md）
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，含 `spec.md`／`checklist.md`／`plan.md`（格式見 workflow/acceptance-spec.md）。每階段結束勾選 plan.md 的階段 checkbox。

## 凍結原則

- spec.md 與 checklist.md 於使用者單次確認後一併凍結（`frozen:` 填日期），開發期間不增刪修改條目；checklist 是 spec 的延伸，矛盾交使用者裁決。
- 需求變更 → 回 R1（標準軌回 M1）重出規格文件，舊檔加 `.superseded` 字尾；核准的修訂寫入檔尾「修訂歷史」。
- **輕量修訂**（規格書本身寫錯，非需求變更——如欄位型別誤植、cmd 打錯）：停手回報 → 使用者核准 → 直接修正並在「修訂歷史」記一行，不必重出整份文件。拿不準是寫錯還是需求變更時，一律當需求變更處理。

## R3 平行實作護欄（「平行 agent 一律唯讀」原則的唯一寫入例外）

只有 R3b 的 architect 實作模式允許平行寫入，前提：R3a 四判準全數成立，且 (a) 每隻檔案/模組範圍互斥（按目錄/package 切分）(b) 共用工作區、不建 worktree、不 merge、不 commit (c) R3c 單一彙整步確認整合一致才交棒。其餘所有平行 agent（分析、審查、探索）一律唯讀。
