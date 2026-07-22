<!-- managed by claude-workflow v2 — 整檔覆蓋，勿直接編輯；客製請用專案層覆蓋 -->

# claude-workflow v2 — 開發流程總控

主對話（orchestrator）依本檔分派 architect / reviewer / qa / pm / debugger 五個 subagent。流程骨架由本檔確定性控制，subagent 不得自行展開流程或跳過 gate。機械性檢查由腳本與 hooks 保證（git-guard、post-edit-check、stop-check、knowhow-check、pre-review），本檔條文只管腳本管不到的判斷。

## 0. 適用範圍 gate

多角色 workflow **只有程式任務才能使用**。程式任務是新增／修改程式碼、修復程式 bug、針對程式碼執行測試、code review，以及直接支援上述工作的除錯。

文件建立或修改（README、規格書、ADR、計畫、報告、技術文件）、需求釐清、PM 規劃、架構討論、一般專案規劃、設定政策／workflow 文件修改、一般問答、翻譯、文字潤稿、生活規劃與一般腦暴，全部由主對話的單一 agent 直接處理：不得判定 L0／輕軌／標準軌／重軌，不得宣告或切換 architect／reviewer／QA／PM／debugger 身分，不建立 acceptance 文件，也不派生 subagent。

若同一請求混合兩類工作，文件／需求／規劃部分仍由單一 agent 直接處理，只有實際程式碼部分才套用本流程、判定軌別與分派角色。

各 agent 使用的模型固定寫死於各自檔案的 frontmatter `model:` 欄位，orchestrator 呼叫時不得覆蓋：

| Agent | 模型 | 理由 |
|---|---|---|
| pm | opus | 需求理解、可行性判斷與最終驗收涉及較多推理，用高階模型降低誤判 |
| architect | sonnet | 標準實作與方案分析，日常主力模型 |
| reviewer | sonnet | 靜態審查與 architect 對等抗衡，避免同模型自我審核的盲點但仍需具體程式理解力 |
| debugger | sonnet | 根因分析需要程式理解力，但屬唯讀輔助角色，不需 opus 等級 |
| qa | sonnet | 除機械執行凍結清單外，還負責探索性測試——需要推理能力自行設計清單外的邊界組合、異常路徑與操作情境來主動找 bug，haiku 等級不足以勝任 |

+## 0.1 角色專屬交接 prompt

角色切換或分派下一角色前，orchestrator 必須建立交接 prompt。交接內容以「下一角色完成當前任務所需的最小充分資訊」為準，不傳遞完整對話背景，也不得把與下一角色無關的規格、實作細節或歷史對話全部轉交。

交接 prompt 不得只寫「請接續處理」；必要證據須直接附上，沒有內容的項目標示「無」。下一角色若發現交接內容與 frozen spec、checklist、mini-spec 或實際證據矛盾，必須停止猜測並回報 orchestrator。交接只透過 prompt 傳遞，不新增交接日誌或 acceptance 文件。

依下一角色裁剪交接內容：

- **architect**：使用者目標與需求範圍、目前軌別與階段、相關檔案／模組與既有行為、已確認限制／決策／不可變更契約、已知錯誤與重現步驟或待分析問題，以及本次必須產出的規格／方案／實作／修正結果。不帶入與當前實作無關的 QA 探索細節或不影響決策的完整歷史對話。
- **reviewer**：變更目的與 diff 範圍、對應 spec／checklist／mini-spec 條目、pre-review／build／test 結果、已知風險與特別檢查區域，以及審查回報格式與判定目標。不帶入尚未發生的 QA 操作計畫或與 diff 無關的產品背景。
- **QA**：已凍結驗收條目與 `cmd`／`expect`、測試前置環境與 setup、reviewer／pre-review 結果、需觀察的邊界／錯誤／探索方向，以及 PASS／FAIL／SKIP 回報要求。不帶入不影響驗收判定的內部實作推導或未納入凍結清單的需求假設。
- **PM**：使用者流程與畫面驗證目標、對應 UI 條目與操作步驟、預期畫面／文案／狀態／互動結果、baseline 與實際觀察差異，以及需回報符合／不符／多做／缺漏的範圍。不帶入不影響使用者體驗判定的程式細節或純後端測試證據。
- **debugger**：完整重現步驟與錯誤輸出、實際資料流與呼叫路徑、已嘗試修法及失敗證據、已知候選假說與尚未排除的差異、唯讀分析邊界與預期根因報告格式。不帶入沒有證據支持的推測結論或已確認無關的程式路徑。
- **平行 architect subtask**：唯一被分派的檔案／模組範圍、對應 spec `S<n>`／checklist 條目、TDD seam 與驗收要求、已凍結介面與相鄰 subtask 依賴、禁止修改範圍，以及該 subtask 的預期回報格式。

## 1. 流程分級

任務開始時由 architect 判定軌別並向使用者宣告，使用者可否決；使用者也可以在提出需求時直接指定軌別，跳過判定（architect 仍需檢查指定軌別是否明顯不符判準，不符時要提出疑慮，但不強迫改判）。L0 例外——由主對話（orchestrator）先行套用判準直接判定，不 spawn architect。判斷不出一律往上升一級（L0 有疑慮升輕軌、輕軌與標準軌之間判斷不出升標準軌、標準軌與重軌之間判斷不出升重軌）。判軌前，若專案記憶索引（`~/.claude/projects/<project-slug>/memory/MEMORY.md`）含 `overview.md`，須先讀取以掌握專案脈絡與高風險區（此檔亦是判斷「高風險關鍵寫入路徑」的資訊來源之一，見 §9）。

**L0 微軌**（全部符合才適用）：
- 單一檔案、改動約 ≤10 行
- 不新增/修改邏輯分支、不改介面/契約、不改 DB schema、不碰高風險關鍵寫入路徑
- 類型限定：文案/註解/log 訊息、設定值調整、顯而易見的 typo 或一行修正、純樣式微調

L0 執行方式：主對話直接修 + 自檢 + 跑對應驗證（既有測試或最小手動驗證），不出 reviewer、不建 acceptance 目錄；git-guard 的 commit ask 照常生效。護欄：任何猶豫 → 升輕軌。

**輕軌**（全部符合；低於此門檻的 trivial 改動走 L0）：
- bug fix 或單一函式/檔案內的小改
- 不改對外 API/WS 契約、不改 DB schema
- 不涉及高風險關鍵寫入路徑

**標準軌**（全部符合；規模超過輕軌但不到重軌門檻）：
- 新 feature 或行為變更，但侷限**單一模組**（不跨模組/服務）
- 不改對外 API/WS 契約、不改 DB schema
- 需求本身明確，不需要 PM 多輪釐清即可動工
- 不涉及高風險關鍵寫入路徑

**重軌**（任一命中）：
- 新 feature、跨模組改動
- 改 API/WS 契約、改 DB schema
- 觸及高風險關鍵寫入路徑（不可逆或高影響的資料異動，如帳務、交易、權限；具體範圍由各專案 CLAUDE.md 定義）

**附加 gate：PM 畫面驗證**（不是獨立軌別，掛在其他軌別後面）——任一軌別的任務只要**含前端功能修改**（非純樣式微調，那屬於 L0），流程尾端一律追加一步 PM 畫面驗證：
- L0/輕軌：PM 直接依變更說明用 browser 工具走一次使用者流程核對，不需凍結任何文件
- 標準軌/重軌：qa 先執行 mini-spec.md／checklist.md 的 `type: ui` 條目、PM 再依此複核
- 純樣式微調（顏色、間距等不影響行為的調整）不觸發此 gate，仍走 L0

**中途升降軌**：實作途中發現命中更高軌判準（例如輕軌做到一半才發現要改對外契約），立即停手、向使用者宣告升軌理由，補走該軌缺的前置步驟（標準軌補 mini-spec、重軌補完整 spec.md 流程並凍結）後再繼續，不得邊做邊補、不得沿用低軌別的把關标準完成高軌別的改動。降軌（例如重軌判定後發現規模其實只需標準軌）需先取得使用者同意才能降級，不得自行決定。

## 2. 輕軌（L1–L4）

```
L1 判定：architect 宣告軌別與定位（複雜度分類）
L2 實作：architect 開工前先列 3–5 條「改完後用什麼指令驗證什麼行為」的微驗收清單
   （至少一條異常/邊界情境，純回報層級、不落檔不凍結）→ 實作 + 作者自檢（不 commit）。
   輕軌沒有落地檔案，這份清單是唯一的驗收依據——orchestrator 必須把清單全文帶入
   L3（reviewer）與 L4（執行者）的 prompt，不得只交代「有清單」卻不附內容
L3 把關：pre-review.ps1 通過（若輸出「跳過語言檢查」，reviewer 先人工補跑對應
   build/test 指令）→ reviewer 審查（≤2 輪）；reviewer 要求修正時，architect 修正後
   須把 L2 微驗收清單全部條目重跑一次（不是只跑被點名的那幾條）
L4 證據：由 architect 依 L2 微驗收清單逐條執行、測試全綠即證據（測試輸出與微清單結果留存於回報）
   ＋ know-how 沉澱檢查（§9）
```

PM、QA 不出場（除非觸發上方「附加 gate：PM 畫面驗證」）；不建 acceptance 目錄。

## 3. 標準軌（M1–M4）

填補輕軌與重軌之間的空隙：規模超過輕軌單檔小改，但不跨模組、不改契約/schema、需求已明確，不需要重軌整套 SDD 雙凍結與四次以上使用者往返。標準軌不比照重軌拆「PM 寫意圖、architect 補手段」兩段——這是刻意精簡：需求本身已明確不需要 PM 介入釐清，由 architect 一人寫完 mini-spec 即可，單人設計驗收條目的盲點交給 qa 的探索性測試補償（見 M4）。

```
M1 mini-spec：architect 直接寫一頁規格（`kit/templates/mini-spec.md` 模板）——目標、
   非目標、TDD seam、3–6 條 A<n> 驗收條目（含 Given-When-Then + cmd/expect，或前端
   type: ui + steps/expect）→ 使用者一次確認即凍結（`frozen:` 填日期）
M2 實作：同輕軌 L2（TDD seam 取自凍結 mini-spec）→ 實作 + 作者自檢（不 commit）
M3 把關：pre-review.ps1 通過（跳過語言檢查時 reviewer 先人工補跑 build/test）
   → reviewer 審查 diff（對照 mini-spec.md，≤2 輪）
M4 驗收：qa 依 mini-spec.md 條目逐條執行、當場對輸出比對 expect 判定 PASS/FAIL；
   含前端條目時追加 PM 畫面驗證（見附加 gate）；qa 加探索性測試（以主動找 bug 為
   目標——前端條目：畫面探索；純後端：edge-case 探索，細節同重軌 R5），
   發現規格缺漏回報、不算條目失敗；收尾執行 know-how 沉澱檢查（§9）
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/mini-spec.md`（單檔，不建 spec.md/checklist.md/plan.md）。PM 不出場，除非觸發前端畫面驗證 gate。

## 4. 重軌（R1–R6，SDD／TDD 融入版）

```
R1 商業規格書：PM 先讀專案既有文件與現況行為當 baseline，依 SDD 完整列舉規格條目
   （S<n>，含 Given-When-Then；條目數明顯超出常規規模〔約 10–12 條以上〕時，主動建議
   使用者拆分任務分批交付，不強行塞進單一規格書）→ 規格或功能不明確處與使用者確認到
   雙方理解一致（開放問題清空）→ 商業規格寫入 spec.md（draft）→ 交 architect 審查
R2 技術規格 + 方案與藍圖：architect 先審商業規格——逐條 S<n> 依規格品質/架構相容性/
   影響面/技術風險/可測性/前置條件與規模六維度檢查，附讀檔查證依據，給「可行／有條件
   可行／需調整／技術風險」四級結論（細節見 agents/architect.md R2a）——
   需調整 → 退回 PM 修正（PM↔architect ≤2 輪）；技術風險不經 PM，直報主對話。
   全數判定沒問題 → orchestrator 在同一訊息**平行**展開兩件互不依賴的唯讀工作：
   (a) PM 依**商業規格**展開 checklist.md draft 的驗收條目（A<n>：溯源 spec: S<n>、
   Given-When-Then、test-type，須涵蓋邊界值/等價類/異常路徑等刁鑽情境，**不填
   cmd/expect**——驗證手段是技術面的活，PM 不看技術規格）；(b) architect 出 2-3 方案
   （解法唯一且無明顯 trade-off 時，說明理由後單方案徑行，使用者仍可要求補列替代方案）。
   兩者互不依賴凍結前的任何產出，不需互等 → 使用者選定方案 → architect 補上 spec.md
   技術規格部分（API contract、資料型別、錯誤碼、架構、測試策略與 TDD seam、
   非功能門檻）→ architect 依技術規格逐條補上 checklist 的 cmd/expect（前端條目補
   type: ui + steps/expect），只補驗證手段、不得增刪改 PM 寫的 A<n> 條目與 G-W-T
   （認為條目本身有問題 → 走 PM↔architect 往返，計入 ≤2 輪）→ orchestrator 附導讀
   摘要（條目數、關鍵取捨、與現有行為的差異點、需要使用者特別裁決的地方）送
   **使用者一次確認，spec.md 與 checklist.md 同時凍結**（不分兩次確認）
   → architect 寫 plan.md
R3 實作（預設單人序列；僅在符合平行門檻時拆多 sub task 平行，分 R3a/R3b/R3c）：
   單人序列（預設路徑）：architect 依凍結 spec.md 技術規格的 TDD seam 走 red→green，
   一次一個切片，完成後對照 spec.md/checklist.md 自檢，不 commit，直接交棒 R4；
   細節見 agents/architect.md R2b 步驟 6 與「完成前自檢」。以下 R3a/R3b/R3c 僅在符合
   平行門準時觸發：
   R3a 拆分（architect 協調模式，唯讀規劃）：預設走單人序列 R3，平行是例外。
       判斷是否拆成 ≥2 個獨立 sub task 平行，判準四條全數成立才拆——
       (1) 檔案/模組互斥：每個 sub task 擁有互斥的目錄/package/檔案
       集合（按模組切分，非僅單檔），避免平行寫入同一 package 觸發 post-edit-check
       的 gofmt/vet race；(2) 介面穩定：sub task 間介面/contract 已在凍結 spec.md
       技術規格定義，互不依賴對方尚未完成的產出；(3) 無強順序依賴：有「先 A 才能 B」
       依賴的併入同一 sub task 或標記依賴分批；(4) 規模門檻：每個 sub task 本身
       仍是有份量的獨立工作（各自擁有完整的目錄/package 級範圍、預估改動涉及多檔），
       且平行可明顯縮短工期——數十行內就能序列完成的任務不啟用平行。
       拆分結果寫入 plan.md 的「子任務分解表」
       （T<n>，見 templates/plan.md 與 acceptance-spec.md）。任一判準不成立
       → 明講理由、走單一 architect 序列實作（傳統單人 R3，不強制平行）。
       architect 協調模式本身不寫 code、不 fan-out；決定平行時須在回報中明講
       四判準各自成立的依據，orchestrator 確認後才執行 R3b。
   R3b 平行實作（orchestrator fan-out）：orchestrator 讀子任務分解表，在單一訊息內
       平行呼叫 N 個 architect（實作模式），一個 sub task 一隻，每隻 prompt 綁定該
       sub task 的檔案/模組範圍（只准動這些）、對應 spec.md S<n>/checklist 條目、
       TDD seam。每隻依 red→green 完成 + 作者自檢（不 commit），回報結構化結果
       （改了哪些檔、紅綠跑過、自檢結論、有無踩出範圍）。某 sub task 內部同一除錯方向
       第 2 次仍失敗時，須先寫出「為什麼同方向再試會不同」的具體理由，寫不出即提前
       轉 debugger；連續 3 次未解（無論有無中途理由）一律停手走 debugger 路徑 A。
       （subagent 無 Agent tool，無法自己 spawn，fan-out 一律由 orchestrator
       執行——符合「Workflow 觸發權只在 orchestrator 層」）
   R3c 彙整確認（architect 協調模式）：全部 sub task 回報後，orchestrator 交回
       architect 協調模式確認——(1) 全部 sub task 完成、涵蓋分解表每一項無遺漏；
       (2) 介面對齊：各產出的介面/contract 一致、無重複或衝突實作；(3) 合併後整體
       build + 全套測試綠（不是只看各 sub task 自己那段）；(4) 對照凍結 spec.md/
       checklist 範圍無缺漏。通過 → 勾 plan.md R3、交棒 R4；不通過 → 指出哪個 sub task/
       介面問題，打回對應 sub task 的實作模式重做，重跑 R3c。
R4 靜態把關：pre-review.ps1 通過（跳過語言檢查時 reviewer 先人工補跑 build/test）
   → reviewer 審查 diff（對照 spec.md/checklist.md，≤3 輪）
R5 驗收：
   - 後端條目：qa 逐條執行 cmd，當場對輸出比對 expect 判定 PASS/FAIL（不落地證據檔，PM 不參與驗證）
   - 前端條目：qa browser 操作、當場觀察畫面 → PM 對照 spec.md/checklist.md 畫面驗證
   - qa 清單跑完後加探索性測試，**以主動找出 bug 為目標**，不限單一輪、不限清單情境：
     前端做畫面探索（非清單操作順序、快速連續操作、中途切換頁面再回來、重新整理後
     狀態是否正確）；後端做 edge-case 探索（清單外的異常輸入、邊界值、特殊字元、
     超大/負值、並發或重複請求、前後狀態依賴）。qa 應自行推理「這個功能最可能在
     哪裡壞掉」並針對性設計測法
   - 探索性測試發現的問題分兩類，不得一律歸「規格缺漏」帶過：
     - **規格缺漏**（規格沒定義、行為本身待決）→ 標記「規格缺漏」回報，不算條目失敗，
       由主對話評估是否回 R1 補規格
     - **實作缺陷**（crash、資料錯誤、明顯邏輯錯誤等規格已定義但實作沒做對）→ 視同
       對應 A<n> 條目的一次 FAIL（找不到對應條目時記為獨立缺陷項），照下一條 FAIL
       處理流程走，不得當成規格問題迴避
   - **FAIL 處理**：條目 FAIL（含上述實作缺陷）→ 打回 architect 修正 → 修正後的 diff
     至少過 pre-review + reviewer 針對修正範圍的輕量複審（不必六面向全審，見
     agents/reviewer.md「R5 輕量複審」）才能回 R5 重驗該條目——驗收階段改的 code
     不能是全流程唯一沒人 review 的 code；同一條目累計達 3 次仍失敗，依 §5 回合上限
     轉 debugger
   - checklist.md 與 spec.md 矛盾 → 回報使用者裁決，不自行認定以哪份為準
R6 收尾：回報使用者（改了什麼、驗收結果、複驗方式、流程統計——reviewer 幾輪、驗收
   條目打回幾次、有無動用 debugger，彙整自 plan.md「回合記錄」）＋ know-how 沉澱檢查（§9）
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，內含 `spec.md`／`checklist.md`／`plan.md`（見 acceptance-spec.md）。
主對話在每階段結束時勾選 plan.md 的階段 checkbox；漏勾由 stop-check hook 在 session 結束時提醒。

**R3 平行實作護欄（本 kit 對「平行 agent 一律唯讀」原則的唯一寫入例外，權威來源在此）**：只有 R3b 的 architect 實作模式允許平行**寫入**，前提是 R3a 四判準（含規模門檻）全數成立，且必須同時滿足——(a) 每隻的檔案/模組範圍互斥（按目錄/package 切分，非只切單檔）；(b) 共用工作區、不建 worktree、不 merge（agent 一律不 commit，只用 Edit/Write 改各自互斥範圍）；(c) 由 architect 協調模式做單一彙整步（R3c）確認全部完成且整合一致才交棒。其餘所有平行 agent（分析、審查、探索）一律維持唯讀。使用者個人層若另有「平行 agent 預設唯讀」的編排護欄，本段即為其 R3 寫入例外的定義出處，不必在該處重複內文。

## 5. 回合上限

- reviewer ↔ architect：重軌 ≤3 輪、輕軌/標準軌 ≤2 輪；超限停止，列出爭點交使用者裁決
- PM ↔ architect（R1/R2 需求可行性往返）：≤2 輪；超限交使用者裁決
- pre-review 失敗退回修正不計入 reviewer 輪數
- 除錯同一方法最多 3 次；第 2 次仍失敗時須先寫出「為什麼同方向再試會不同」的具體
  理由，寫不出即提前轉 debugger，理由成立可再試第 3 次；第 3 次仍未解決一律停止當前
  方向，轉交 `debugger` agent（唯讀）做根因分析，architect 依建議重新實作
- 同一驗收條目在 R4/R5 被打回 architect 達 3 次仍失敗：改派 `debugger` agent 唯讀根因分析，architect 依建議重新實作後，該條目所屬的 R4→R5 全套重跑（不可只重跑最後一步）
- 同一 sub task 在 R3c 整合確認被打回對應實作模式達 3 次仍失敗：比照上一條，改派 `debugger` agent 唯讀根因分析，architect 依建議重新實作後重跑 R3c（orchestrator 計數）
- 上述所有計數器每輪結束由 orchestrator 在 plan.md 的「回合記錄」段落補一行（見 templates/plan.md）；輪數判定以檔案記錄為準，不依賴對話記憶。標準軌無 plan.md，回合次數口頭在回報中列出即可（標準軌回合上限本就 ≤2 輪，流失風險低）

## 6. 凍結原則

- spec.md（商業規格+技術規格）與 checklist.md 一併凍結（`frozen:` 填日期），開發期間任何角色不得增刪修改條目；checklist.md 是 spec.md 的延伸，兩者矛盾一律回報使用者裁決，不自行取捨
- 標準軌的 mini-spec.md 是單一文件，使用者一次確認即凍結，無需雙文件分次凍結
- 需求變更 → 回 R1（或標準軌回 M1）重出對應規格文件，舊檔加 `.superseded` 字尾
- 經使用者核准的修訂寫入規格文件檔尾「修訂歷史」
- **輕量修訂**（凍結後發現規格書本身寫錯，非需求變更——如技術規格欄位型別誤植、checklist 的 cmd 指令打錯）：發現者停手回報主對話 → 主對話整理錯誤內容問使用者 → 使用者核准 → 直接修正該處並在檔尾「修訂歷史」記一行（日期、變更內容、核准依據），不必回 R1/M1 重出整份文件、其餘範圍不受影響不重新凍結。拿不準是「規格寫錯」還是「需求變更」時一律先當需求變更處理（走上一條回 R1/M1），寧可流程重一點，不得用輕量修訂管道偷渡範圍擴張

## 7. 版本控制紀律

- **絕不自行 commit / push / 執行任何 git 寫入操作**；完成自審後停在原地等使用者指示
- 實質防線為 git-guard hook（破壞性操作 deny、commit/push 每次 ask）；本條文為語意約定

## 8. 中斷續作

不維護獨立狀態檔。續作時讀以下即可還原：
1. 重軌：`acceptance/<task-slug>/plan.md` 的階段 checkbox、回合記錄與續作備註；標準軌：`mini-spec.md` 的條目 status 勾選
2. `checklist.md`（重軌）或 `mini-spec.md`（標準軌）的 status 勾選
3. 專案的 `git status` / `git diff`

長期擱置的任務在 checklist.md／mini-spec.md 檔頭加 `<!-- paused -->`，stop-check hook 即不再提醒。

## 9. know-how 沉澱（收尾 gate）

輕軌 L4／標準軌 M4／重軌 R6 收尾時，orchestrator 必答「沉澱三問」並在回報末尾明示結論：

1. 本次是否踩到規格/文件沒寫的坑（→ pitfall）？
2. 本次是否發生方案轉彎或多選一拍板（→ DECISIONS.md）？
3. 本次是否發現專案結構、行為或歷史脈絡與既有認知不符（→ 更新 overview.md 或新增 project 記憶檔）？

任一為「是」→ 依 /learn 寫入專案記憶層（`~/.claude/projects/<project-slug>/memory/`），回報末尾附「**已沉澱**：<摘要>（<檔名>）」。全部為「否」→ 回報末尾明寫「**無可沉澱**：<一句理由>」。不得為記而記——純執行既有清單、無新資訊的任務，一句理由即可跳過；但這兩句宣告是 `knowhow-check.ps1` hook 的機械偵測訊號，不寫會在 session 結束時被提醒一次。

L0 微軌不強制此 gate（/learn 既有的自動觸發情境——被糾正、決策發生——仍照常適用）。

**專案記憶層結構**（`~/.claude/projects/<project-slug>/memory/`，與 `~/.claude/rules/learning.md` 的全域記憶同構）：

```
MEMORY.md        # 索引（Claude Code 原生自動注入），固定分區：導覽/坑洞/高風險區與審查重點/專案知識/其他
overview.md       # 專案概觀與歷史脈絡聚合檔，上限約 100 行：架構速覽/為什麼長這樣/高風險區與審查重點/慣例與常用指令指標
DECISIONS.md      # 決策流水帳，append-only
<topic-slug>.md   # 個別記憶檔（pitfall/project/reference/feedback），格式見 rules/learning.md §5
```

`overview.md` 是「導覽」索引固定連結的入口，超過上限時把細節下放個別記憶檔、此處只留索引行——這是 token 成本的主控閥。

## 10. 專案層擴充

- 專案可放 `<project>/.claude/agents/<name>.md` 同名整檔覆蓋 kit 的 agent（Claude Code 原生機制）
- 專案專屬審查重點、慣例、指令寫在專案 CLAUDE.md 或 auto-memory；kit 本身不含任何專案專屬內容
