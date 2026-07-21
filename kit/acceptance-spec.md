<!-- managed by claude-workflow v2 — 整檔覆蓋，勿直接編輯；客製請用專案層覆蓋 -->

# 驗收規約（acceptance-spec）

本檔定義重軌任務的規格書、驗收清單格式與證據規則。**格式為嚴格規約**：`verify-evidence.ps1`、`stop-check.ps1` 與 qa/pm/architect agent 都依此 parse，不得自創變體。

## 目錄結構

任務目錄建在全域 `.claude` 的專案對應目錄底下，不放專案 repo：

```
~/.claude/projects/<project-slug>/acceptance/<task-slug>/
├── spec.md           # PM 商業規格 + architect 技術規格（SDD 規格書，見下）
├── checklist.md       # PM 依 spec.md 展開、凍結的驗收清單
├── plan.md            # architect 藍圖 + 階段進度（見 templates/plan.md）
└── evidence/
    ├── pre-review.txt
    ├── A1.txt        # 後端條目證據（指令輸出）
    └── A2.png        # 前端條目證據（截圖）
```

`<project-slug>` 為 Claude Code 對專案路徑的編碼（例：`C--Users-jacky-Documents-myproject`），與該專案 auto-memory 同層。

## spec.md 格式（SDD 規格書，用 `kit/templates/spec.md` 模板）

規格書分兩部分、兩階段完成，是 checklist.md 的推導來源：

- **商業規格**（PM，R1 產出）：目標／範圍／非目標，逐條規格 `### S<n> <行為一句話>`（輸入／輸出／邊界與錯誤處理／Given-When-Then）。規格或行為不明確處記入「釐清紀錄」，經主對話轉呈使用者確認到清空、雙方理解一致後才能送 architect 審查——不得用「照既有行為」自行填補，這一步就是要問清楚。
- **技術規格**（architect，R2 產出）：architect 收到商業規格先審「能不能做、有沒有風險」——**無法實作或有風險就退回 PM 修正**（R1/R2 需求可行性往返 ≤2 輪，見 `WORKFLOW.md`），不得直接動手轉換。審查通過後才補 API/介面 contract、資料型別、錯誤碼定義、架構與模組劃分、測試策略與 TDD seam、非功能性需求門檻、建議測試項目，一併寫入 spec.md。

**檔頭**：
```markdown
# <任務標題> — 規格書（spec.md）
- project: <專案根目錄絕對路徑>
- frozen: <YYYY-MM-DD>（商業規格與技術規格都補齊、經使用者確認後才填；之前是 draft）
```

**凍結時機**：商業規格與技術規格一併於使用者確認技術規格後凍結（`frozen:` 填日期），不分兩次凍結——商業規格確認後只是「送審中」，尚未凍結，architect 仍可能因發現風險而退回修正。凍結後與 checklist.md 同受第「凍結原則」章節規範。

## checklist.md 格式

checklist.md 由 PM 依凍結的 spec.md 展開，每條驗收條目**必須**溯源到規格書的一條 `S<n>`，不得憑空新增規格書沒有的行為、也不得遺漏規格書裡的必驗行為（規格書每條 S\<n\> 至少對應一條驗收條目）。展開時比照下列七個測試設計層次檢查覆蓋率，不得只寫 happy path：規格逐條、Given-When-Then 驗收標準、邊界值分析、等價類劃分、異常／錯誤路徑、使用者情境（探索性測試回饋補入，見 R5）、非功能性需求。

### 檔頭（必填）

```markdown
# <任務標題>
- project: <專案根目錄絕對路徑>
- frozen: <YYYY-MM-DD>（凍結日期；未凍結前寫 draft）
```

可選標記：檔頭加 `<!-- paused -->` 表示任務暫停，stop-check hook 會跳過此任務。

### 條目格式 — 後端型（預設）

```markdown
### A1 斷線重連後餘額不重複入帳
- spec: S3
- test-type: 異常路徑
- given: 使用者已下注且連線中斷
- when: 10 秒內重新建立連線
- then: 餘額與注單狀態與斷線前一致，不重複入帳
- cmd: `go test ./domain/wagers/... -run TestReconnectIdempotent -v`
- expect: `ok\s+`
- evidence: evidence/A1.txt
- status: [ ]
```

規則：
- 條目編號 `### A<n> <行為描述>`，n 從 1 遞增，不得跳號
- `spec`：對應的規格書條目編號 `S<n>`；找不到對應規格時停下回報，不自行假設
- `test-type`：`規格逐條` / `邊界值` / `等價類` / `異常路徑` / `情境` / `非功能` 六類之一，標明這條驗證的是哪個測試設計層次，供完整性自檢時盤點覆蓋率
- `given` / `when` / `then`：對應規格書該條的 Given-When-Then，供人類與 QA 快速理解「為什麼要驗這條」；`cmd`/`expect` 才是機器判定依據
- `cmd`：單行、以 `project:` 路徑為工作目錄可直接執行（go test / curl / docker exec ... mysql / docker exec ... redis-cli 等）
- `expect`：regex，對 evidence 檔內容比對（PowerShell `Select-String` 語法）
- `evidence`：相對於任務目錄的證據檔路徑
- `status`：`[ ]` 未驗、`[x]` 已驗通過；由主對話依 qa 的 PASS/FAIL 總表回填
- 需前置環境（如 server 需先啟動）的條目加一行 `- setup: <說明>`；verify-evidence 的 `-Rerun` 對含 setup 的條目只做靜態檢查並標註「需人工重跑」

### 條目格式 — 前端型（僅修改前端功能時使用）

```markdown
### A2 登入頁錯誤提示正確顯示
- spec: S5
- test-type: 規格逐條
- given: 使用者在登入頁
- when: 輸入錯誤密碼並送出
- then: 畫面顯示「帳號或密碼錯誤」提示
- type: ui
- steps: 開啟 <URL> → 輸入錯誤密碼 → 送出
- expect: 畫面顯示「帳號或密碼錯誤」提示
- evidence: evidence/A2.png
- status: [ ]
```

規則：
- `type: ui` 為前端型識別標記；`steps` 為 browser 操作描述、`expect` 為畫面預期（人工核對）
- `spec` / `test-type` / `given` / `when` / `then` 規則同後端型
- 證據=截圖檔，由 qa 以 browser 工具執行擷取，PM 人工核對
- verify-evidence 對 ui 型只做檔案存在性與非空檢查，不做內容比對

## plan.md 子任務分解表格式（R3 平行實作用，architect 協調模式於 R3a 填）

重軌 R3 可拆成多個可獨立開發的 sub task 平行開發時，architect 協調模式在 `plan.md`（模板見 `kit/templates/plan.md`）填「子任務分解表」，供 orchestrator fan-out 與 R3c 彙整確認對照：

- 每個 sub task 編號 `T<n>`（n 從 1 遞增）。**一律用 `T<n>` 前綴、不得用 `R<n>`**——`stop-check.ps1` 只把 `- [ ] R<n>` 視為未勾階段，`T<n>` 不會被誤報
- 每個 sub task 必須標明**互斥的檔案/模組範圍**（按目錄/package 切分，不是只切單一檔案），確保多個實作 agent 平行寫入不會動到同一 package
- 每個 sub task 溯源到 checklist 條目/規格書 `S<n>`，並註明取自 spec.md 技術規格的 TDD seam 與依賴（無強順序依賴才可平行）
- status：`[ ]` 未完成、`[x]` 該 sub task 實作模式回報完成且經 R3c 確認
- 拆不出 ≥2 個真正獨立的 sub task 時，分解表留空並註明「不拆，走單人序列 R3」，不得為求平行硬拆出範圍重疊或有依賴的 sub task
- 此表與 R3 整合確認 checklist 供人類與 orchestrator 判讀，`verify-evidence.ps1` 不解析（不影響既有 PASS/FAIL 邏輯）

## 證據檔規則

- 後端證據檔為指令輸出重導向，**首行**必須為：`# <ISO 8601 時間> $ <指令原文>`
- 證據檔不得為空
- **時效**：evidence 檔 mtime 必須晚於 `project:` 路徑最後一次 git commit 時間（防拿舊證據交差）；ui 型截圖同樣適用
- 證據不得含機密（token、密碼、連線字串明文）

## verify-evidence.ps1 行為

- 用法：`powershell -File verify-evidence.ps1 -Checklist <checklist.md 路徑> [-Rerun]`
- 預設（靜態模式）逐條檢查：evidence 檔存在、非空、首行含指令原文（後端型）、內容 match expect（後端型）、status 勾選與檢查結果一致、mtime 時效
- `-Rerun`：後端型逐條以 `project:` 為 cwd 重新執行 cmd、重寫 evidence、即時比對 expect；含 `setup:` 的條目與 ui 型僅靜態檢查
- 腳本不解析 `spec`/`test-type`/`given`/`when`/`then` 欄位（純供人類與 PM/QA 語意核對），不影響既有 PASS/FAIL 判定邏輯
- 輸出 PASS/FAIL 總表；任一 FAIL 即 exit 1

## 凍結原則

- spec.md（商業規格+技術規格）與 checklist.md 一併於使用者確認後凍結（`frozen:` 填日期），開發期間任何角色不得增刪修改條目
- checklist.md 是 spec.md 的延伸、兩者不得衝突：驗收或審查時若發現 checklist.md 與 spec.md 矛盾，回報主對話交使用者裁決，**不得自行認定以哪一份為準**（矛盾代表凍結時展開有誤，需要人判斷怎麼修，不是機械地選一邊）
- 需求變更 → 回 R1 重出 spec.md 與 checklist.md，舊檔改名加 `.superseded` 字尾保留
- 凍結後的修訂（經使用者核准）須在 spec.md 與 checklist.md 檔尾「修訂歷史」段落各記錄一行：日期、改了什麼、核准依據
- architect 在 R3 實作過程中若同步更新了目標專案自己的常駐規格文件（例如專案 docs 路由指向的規格檔），那是另一份文件、僅供該專案長期參考，不是本節的 spec.md，不能拿來取代或凌駕凍結的 spec.md/checklist.md
