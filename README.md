# agent-workflow

> 本 repo 採用 AI Workflow 共用目錄架構：共用內容只維護一份，Claude/Codex 僅安裝平台 adapter。

可攜的開發流程 kit：五角色 subagent（architect / reviewer / qa / pm / debugger）+ 流程分級四級（L0/輕軌/標準軌/重軌，標準軌與重軌為 SDD／TDD 融入版）+ 後端化驗收判定 + hooks 硬護欄 + 自我學習迴圈（learn / evolve）+ 專案 know-how 累積（收尾 gate + knowhow-check hook）+ TDD 紅綠迴圈（tdd skill）。

核心理念：**確定性下沉**——凡是能用腳本或 hook 保證的，不寫成條文；條文只留給機器判不了的判斷。流程 gate 由四支 hooks（git-guard / post-edit-check / stop-check / knowhow-check）+ pre-review 機械把關；狀態 = acceptance 目錄本身（checklist/mini-spec 勾選 + plan.md），無獨立 state checkpoint；後端驗收 = e2e 指令即時判定，不落地證據檔；安裝以 `~/.agents` 為唯一共用來源，平台只保留必要入口與設定差異。

多角色 workflow 僅適用於程式任務；文件、規格、需求、規劃、設定政策與一般文字工作均由單一主 agent 處理。混合請求只把實際程式碼部分送入多角色流程。

## 目錄結構

```
workflow/               唯一共用流程來源
agents/ skills/ rules/  共用角色、技能與規則
scripts/ templates/     共用工具與模板
hooks/                  共用 hook 實作
adapters/shared/        manifest 與跨平台路徑 helper
adapters/claude/       Claude CLAUDE.md 入口與 settings.json hooks schema
adapters/codex/        Codex AGENTS.md 入口、hooks.json 與 execpolicy rules
examples/              驗收清單範例、專案層覆蓋機制說明
tests/                  hook 與 installer acceptance tests
install.ps1
```

## 安裝（Windows）

```powershell
git clone https://github.com/tian841224/claude-workflow
cd claude-workflow
.\install.ps1              # canonical 裝到 ~/.agents/core，並建立平台 adapter
.\install.ps1 -DryRun      # 先看會動哪些檔
.\install.ps1 -Target D:\test\fake-home   # 測試安裝
```

預設 canonical 目錄為 `~/.agents`。`~/.agents/` 下的 workflow、agents、skills、rules、scripts、templates、hooks 與 `AGENTS.md` 只有一份；平台目錄使用 junction/symlink 指向它，無法建立連結時才 fallback 為複製。可用以下指令檢查或修復：

```powershell
.\install.ps1 -Action Status
.\install.ps1 -Action Repair
.\install.ps1 -Action Uninstall
```

repo 根目錄的共用目錄是唯一來源，`adapters/claude/` 與 `adapters/codex/` 只放各平台的 hook schema、execpolicy 與設定合併格式。`~/.claude/CLAUDE.md` 與 `~/.codex/AGENTS.md` 直接指向 `~/.agents/AGENTS.md`；舊的 `claude-workflow` 路徑會保留為 deprecated compatibility junction，不應再直接編輯。

安裝器可選擇目標 AI agent；預設 `Both` 以維持既有相容性：

```powershell
.\install.ps1 -Agent Claude   # 只安裝 Claude Code 原生架構
.\install.ps1 -Agent Codex    # 只安裝 Codex 原生架構
.\install.ps1 -Agent Both     # 兩套都安裝（預設）
```

`-Agent` 也可寫成 `-Platform`。Codex 模式會讓 `~/.codex/AGENTS.md` 指向 `~/.agents/AGENTS.md`，並安裝 Codex `hooks.json` 與 `rules/default.rules`；Claude 模式則讓 `~/.claude/CLAUDE.md` 指向同一份共用 `AGENTS.md`，再安裝 Claude `settings.json` hooks。

共用 workflow 會安裝到 `~/.agents/`。Claude 與 Codex 只連結 repo 管理的 agents、skills、rules 項目；目標目錄中其他既有 agent、skill、rule 與 Codex 原生檔案會保留，不會整個目錄替換：

```powershell
.\install.ps1 -ClaudeTarget "$env:USERPROFILE\.claude" -CodexTarget "$env:USERPROFILE\.codex"
```

`-Target` 仍是 `-ClaudeTarget` 的相容別名。

安裝行為（冪等，重跑 = 升級）：

| 層 | 內容 | 行為 |
|---|---|---|
| canonical 層 | `~/.agents/AGENTS.md`、`workflow/`、共用 `agents/`、`skills/`、`rules/`、`scripts/`、`templates/`、`hooks/` | 共用來源只有一份；repo 更新後重新執行 installer 同步 |
| Claude 入口 | `~/.claude/CLAUDE.md` | symlink 指向 `~/.agents/AGENTS.md`；權限不足時 fallback 為複製，既有不同內容先備份 |
| Codex 入口 | `~/.codex/AGENTS.md` | symlink 指向 `~/.agents/AGENTS.md`；權限不足時 fallback 為複製，既有不同內容先備份 |
| 平台設定 | Claude `settings.json`、Codex `hooks.json`／`rules/default.rules` | 只合併或更新平台專屬受控設定，既有自有設定保留 |
| 共用項目 | `~/.claude/agents/`、`~/.codex/agents/` 等 | 只管理 repo 同名項目，其他使用者或 Codex 原生項目不覆蓋 |
| 專案層 | `<project>/.claude/`、專案 CLAUDE.md | 完全不碰 |

注意：settings.json 經 PowerShell 5.1 的 ConvertTo-Json 寫回後，中文會轉為 `\uXXXX` 逸出，功能無損。`install.sh`（Linux/macOS）列為 roadmap，v2 目前以 Windows 為主。

`tdd` skill（單檔 `skills/tdd/SKILL.md`）會隨 `install.ps1` 裝到 `~/.claude/skills/tdd/`；重軌 R3 實作階段已接上紅綠迴圈，seam 直接取自 R2 凍結的 `spec.md` 技術規格「測試策略與 TDD seam」段，不需臨場另外確認（見 `agents/architect.md`）。

`systematic-debugging` skill（`skills/systematic-debugging/SKILL.md` + 三份支援檔）同樣整資料夾裝到 `~/.claude/skills/systematic-debugging/`：`architect` 修 bug（任何軌別的第一手除錯、R5/M4 FAIL 打回修正、R3b 內部除錯）動手前先載入並走四階段（Root Cause → Pattern → Hypothesis → Implementation）；`debugger` 出場時只執行前三階段（蒐證／模式分析／假說驗證），第四階段的修復動作仍由 `architect` 接手——`debugger` 維持唯讀定位不變（見 `agents/architect.md`、`agents/debugger.md`）。

### 專案 know-how 累積

自我學習迴圈的擷取階段過去只靠條文自覺，容易被忘記。v2 把它接進流程骨架：輕軌 L4／標準軌 M4／重軌 R6 收尾時（`WORKFLOW.md` §9）必須回答「沉澱三問」（有沒有踩坑、有沒有方案轉彎、有沒有發現專案脈絡與既有認知不符），並在回報末尾明寫「已沉澱：<摘要>」或「無可沉澱：<理由>」。這兩句宣告是 `knowhow-check.ps1` hook 的機械放行訊號——若 session 對專案有 ≥3 筆實質修改卻既未宣告、專案記憶層（`~/.claude/projects/<slug>/memory/`）也沒更新，Stop 事件會被 block 一次提醒。

專案記憶層結構：`MEMORY.md`（索引，Claude Code 原生自動注入）+ `overview.md`（專案概觀與歷史脈絡聚合檔，上限約 100 行，判軌前需先讀）+ `DECISIONS.md`（決策流水帳）+ 個別記憶檔（pitfall/project/reference/feedback）。全域記憶層（`~/.claude/memory/`）採同構格式，兩者格式定義的權威來源都在 `rules/learning.md`。

## 流程速覽

**L0 微軌**（trivial 改動：單檔約 ≤10 行、不動邏輯分支/介面/schema，限文案/註解/設定值/typo/純樣式）：

```
主對話直接修 + 自檢 + 跑對應驗證，不 spawn agent、不出 reviewer；任何猶豫 → 升輕軌
```

**輕軌**（bug fix / 單一函式/檔案內的小改，不改契約與 schema、不涉高風險關鍵寫入路徑）：

```
L1 architect 判定 → L2 開工前列 3–5 條微驗收清單（至少一條異常/邊界，orchestrator 需
   把清單全文帶入 L3/L4 的 prompt）→ 實作
→ L3 pre-review + reviewer(≤2輪，跳過語言檢查時 reviewer 先人工補跑 build/test；
   要求修正時全部微驗收清單重跑，非只跑被點名的幾條)
→ L4 architect 逐條跑微驗收清單、全綠即證據（結果留存於回報）
```

**標準軌**（新 feature/行為變更但侷限單一模組、不改契約與 schema、需求已明確、不涉高風險路徑——填補輕軌與重軌之間的空隙）：

```
M1 architect 一次寫完 mini-spec.md（目標/非目標/TDD seam/3–6 條驗收條目）
   → 使用者一次確認即凍結
→ M2 實作（TDD seam 取自 mini-spec）→ 作者自檢
→ M3 pre-review + reviewer(≤2輪，對照 mini-spec)
→ M4 qa 逐條執行、當場判定 PASS/FAIL；含前端條目時追加 PM 畫面驗證；
   qa 加探索性測試（前端做畫面探索、純後端做 edge-case 探索），發現的問題分
   「規格缺漏」與「實作缺陷」（視同 FAIL）兩類，不得一律當規格缺漏帶過
```

**重軌**（新 feature/跨模組改動 / 改 API/WS 契約 / 改 DB schema / 高風險關鍵寫入路徑），SDD／TDD 融入版：

```
R1 PM 先讀專案現況當 baseline，依 SDD 完整列規格（S<n> + Given-When-Then，條目數
   明顯超量〔約 10–12 條以上〕建議拆分任務），規格不明確處與使用者確認到雙方理解
   一致 → 商業規格寫入 spec.md
→ R2 architect 先審規格（六維度：規格品質/架構相容性/影響面/技術風險/可測性/前置
   條件與規模，需調整退回 PM ≤2輪、技術風險直報主對話）→ 全數判定沒問題後
   orchestrator **平行**展開 PM 依商業規格展開 checklist draft 驗收條目（G-W-T/
   test-type，不填 cmd/expect）與 architect 出方案+藍圖（解法明顯唯一時可單方案
   徑行）——兩者互不依賴 → 使用者選定方案 → 補技術規格（API contract/資料型別/
   錯誤碼/架構/TDD seam/非功能門檻）→ architect 依技術規格逐條補 checklist 的
   cmd/expect（不得增刪改 PM 條目）→ orchestrator 附導讀摘要送使用者**一次確認，
   spec.md 與 checklist.md 同時凍結**（每條溯源 spec: S<n>）
→ R3 實作（TDD seam 取自 spec.md）：預設單人序列；符合四判準（模組互斥、介面穩定、
   無強順序依賴、規模門檻）才拆 ≥2 個 sub task 平行——architect 協調模式拆分（R3a）
   → orchestrator fan-out 多個 architect 實作模式平行開發（R3b）→ architect 協調模式
   彙整確認全部完成＋整合一致才交棒（R3c）；任一判準不成立就走單人序列 R3
→ R4 pre-review + reviewer 審 diff 對照 spec.md/checklist（≤3輪，跳過語言檢查時
   reviewer 先人工補跑 build/test）
→ R5 驗收：後端 = qa 逐條執行 cmd、當場比對 expect 判定 PASS/FAIL（PM 不參與）
          前端 = qa browser 操作觀察畫面 + PM 對照 spec.md 畫面驗證
          qa 加探索性測試（前端做畫面探索、純後端做 edge-case 探索），發現的問題
          分「規格缺漏」（回報不算失敗）與「實作缺陷」（視同 FAIL 打回 architect）；
          FAIL 修正後須過 pre-review + reviewer 輕量複審（範圍限定）才回 R5 重驗
→ R6 回報（含流程統計：reviewer 輪數、驗收打回次數、有無動用 debugger）+ /learn 沉澱
```

**附加 gate：PM 畫面驗證**（不是獨立軌別）——任一軌別的任務只要含前端功能修改（純樣式微調除外，那屬於 L0），流程尾端一律追加 PM 走一次畫面驗證：L0/輕軌由 PM 直接用 browser 工具核對；標準軌/重軌由 qa 先執行 ui 條目、PM 再複核。前端功能修改因此**不再是重軌的獨立判準**，改依規模落在對應軌別 + 這個附加 gate。

**中途升降軌**：實作途中才發現命中更高軌判準，立即停手宣告升軌、補走該軌缺的前置步驟（標準軌補 mini-spec、重軌補完整 spec.md 流程並凍結）再繼續；降軌需使用者同意。

任務目錄：重軌 `~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，含 `spec.md`／`checklist.md`／`plan.md`；標準軌只有單檔 `mini-spec.md`（詳見 `kit/acceptance-spec.md`）。checklist 是 spec.md 的延伸，兩者矛盾一律交使用者裁決。

**除錯/驗收迴圈**（例外路徑，不是主流程固定關卡，只在卡關時出場，見 `kit/WORKFLOW.md` 第 5 節）：`debugger`（唯讀）有兩條出場路徑——
- 路徑 A：architect 對同一 bug 用同一解法連續嘗試，第 2 次仍失敗時須先寫出「為什麼同方向再試會不同」的具體理由，寫不出即提前停手轉 debugger；理由成立可再試第 3 次，第 3 次仍未解決一律停手，揭露已嘗試的修法與失敗原因，轉交 `debugger` 做根因分析
- 路徑 B：同一驗收條目在 R4（reviewer）/R5（QA）被打回 architect 達 3 次仍失敗，改派 `debugger` 分析後，architect 依建議重新實作，該條目所屬的 R4→R5 全套重跑（不可只重跑最後一步）

兩條路徑 `debugger` 都只執行 `systematic-debugging` skill 的前三階段（蒐證／模式分析／假說驗證）、不改 code、不下修復方案，結論交回 architect。回合計數（reviewer↔architect、PM↔architect、R4/R5 打回、R3c 打回）由 orchestrator 每輪結束記錄到 `plan.md` 的「回合記錄」段落，以檔案為準、不靠對話記憶（標準軌無 plan.md，回合次數在回報中口頭列出即可）。

## 其他 CLI 支援

repo 根目錄的 `AGENTS.md` 是所有 agent 共用的 canonical 指令來源，不再是 Codex 專屬副本。Claude/Codex 的入口檔只負責使用平台要求的固定檔名；hooks schema、execpolicy 與 settings merge 仍由 `adapters/claude/`、`adapters/codex/` 管理。`install.ps1` 會自動建立入口連結與平台設定。

### 回合上限（超限一律停下交使用者裁決，不自行加碼）

| 計數器 | 上限 | 誰維護 | 超過後動作 |
|---|---|---|---|
| reviewer ↔ architect | 重軌 ≤3 輪、輕軌/標準軌 ≤2 輪 | orchestrator | 列出爭點回報使用者裁決 |
| PM ↔ architect（需求可行性往返） | ≤2 輪 | orchestrator | 回報使用者裁決 |
| 同一 bug 內部修復嘗試 | 2 次未解需寫理由才續試，3 次硬上限 | architect 自己計數 | 轉交 `debugger`（路徑 A） |
| 同一驗收條目在 R4/R5 被打回 architect | 3 次 | orchestrator | 轉交 `debugger`（路徑 B），修復後 R4→R5 全套重跑 |
| pre-review 失敗退回 | 不計數 | — | 修正後重跑，不計入 reviewer 輪數 |

上述計數器（除 pre-review 退回）每輪結束由 orchestrator 記錄到重軌 `plan.md` 的「回合記錄」段落，輪數判定以檔案為準；標準軌無 plan.md，回合次數口頭列在回報中即可（上限本就 ≤2 輪，流失風險低）。

### 凍結原則（抉擇一旦定案不可中途變更）

- 重軌：spec.md（商業規格+技術規格）與 checklist.md 一併於使用者**單次**確認後凍結，開發期間任何角色不得增刪修改條目
- 標準軌：mini-spec.md 是單一文件，同樣經使用者一次確認即凍結
- 需求變更 → 回 R1（或標準軌回 M1）重新出規格文件，舊檔加 `.superseded` 字尾，不可就地覆蓋
- 經使用者核准的修訂寫入對應規格文件檔尾的「修訂歷史」，保留可追溯軌跡
- **輕量修訂**（規格書本身寫錯，非需求變更，如技術規格欄位型別誤植）：使用者核准後直接修正並記入「修訂歷史」即可，不必回 R1/M1 重出整份文件；拿不準就當需求變更處理

### Agent 模型固定表（寫死於各 agent frontmatter，orchestrator 不得覆蓋）

| Agent | 模型 | 理由 |
|---|---|---|
| pm | opus | 需求理解、可行性判斷、最終驗收涉及較多推理，用高階模型降低誤判 |
| architect | sonnet | 標準實作與方案分析，日常主力模型 |
| reviewer | sonnet | 靜態審查需具體程式理解力，與 architect 對等但獨立審視 |
| debugger | sonnet | 根因分析需程式理解力，但屬唯讀輔助角色，不需 opus 等級 |
| qa | sonnet | 除執行凍結清單外還負責探索性測試，需要推理能力自行設計清單外的邊界組合與異常情境主動找 bug |

以上四項（回合上限、凍結原則、模型固定表、除錯迴圈）為流程骨架的強制規則，權威定義見 `kit/WORKFLOW.md`（模型固定表在前言之後、流程分級與附加 gate 在 §1、回合上限在 §5、凍結原則在 §6）；README 僅摘要供快速查閱，若與 `kit/WORKFLOW.md` 不一致，以 `kit/WORKFLOW.md` 為準。

## 測試

```powershell
.\tests\run-hook-tests.ps1     # hooks 行為測試
```
