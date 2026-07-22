# claude-workflow v2

可攜的 Claude Code 開發流程 kit：五角色 subagent（architect / reviewer / qa / pm / debugger）+ 流程分級四級（L0/輕軌/標準軌/重軌，標準軌與重軌為 SDD／TDD 融入版）+ 後端化驗收判定 + hooks 硬護欄 + 自我學習迴圈（learn / evolve）+ TDD 紅綠迴圈（tdd skill）。

v2 的核心理念：**確定性下沉**——凡是能用腳本或 hook 保證的，不寫成條文；條文只留給機器判不了的判斷。

## 與 v1 的差異

| v1 問題 | v2 對策 |
|---|---|
| 流程 gate 全靠模型自律 | 三支 hooks（git-guard / post-edit-check / stop-check）+ pre-review 寫死在 reviewer 第一步 |
| 功能軌 F1–F10 對後端太重 | 流程分級四級：L0 微軌主對話直接修；輕軌 4 階段（L1–L4）免 PM/QA；標準軌 4 階段（M1–M4）單檔 mini-spec、一次確認即凍結，填補輕重軌落差；重軌 6 階段（R1–R6）才走完整雙文件凍結流程 |
| 證據=截圖、驗收語彙偏前端 | 前後端雙流程：後端驗收 = e2e 指令即時判定（go test / curl / SQL），不跑畫面；前端才做畫面驗證；兩者皆當場判定、不落地證據檔 |
| state JSON checkpoint 靠模型維護 | 砍除。狀態 = acceptance 目錄本身（checklist 勾選 + plan.md），stop-check hook 掃檔案抓漏 |
| inbox 學習中介與內建記憶重複 | 收編實戰版 learn / evolve skill（直接寫記憶檔、核准制升級），砍 inbox / rules/learning.md |
| Merge-Markdown 按標題合併脆弱 | 分層安裝：kit 層整檔覆蓋、使用者層只 append marker 區塊、settings.json 走結構化 JSON 合併 |

v1 → v2 步驟對照：技術軌 T1–T5 → 輕軌 L1–L4；功能軌 F1–F10 → 重軌 R1–R6（F9 併入驗收、F10 簡化為收尾）。

## 目錄結構

```
kit/
  WORKFLOW.md          流程總控（分級、階段、回合上限、凍結原則、續作）
  acceptance-spec.md   驗收規約（checklist 格式——人與腳本共同遵守）
  templates/           spec.md / checklist.md / plan.md（重軌）、mini-spec.md（標準軌）模板
agents/                architect / reviewer / qa / pm / debugger 五角色定義
                        （模型固定：pm=opus、qa=haiku、architect/reviewer/debugger=sonnet，寫死於各檔 frontmatter `model:`）
skills/                learn（經驗擷取）/ evolve（週回顧精煉）/ tdd（red→green 測試紀律，含 tests.md / mocking.md，seam 取自 spec.md 技術規格）
hooks/
  git-guard.ps1        PreToolUse：破壞性 git 操作 deny、commit/push 每次 ask
  post-edit-check.ps1  PostToolUse：.go 檔編輯後 gofmt/go vet 快檢；.ts/.tsx/.js/.jsx 檔在本地已裝 prettier 時跑 prettier --check（不透過 npx 觸發安裝）；失敗立即打回
  stop-check.ps1       Stop：session 結束前掃驗收缺件提醒
  weekly-review-check.ps1  SessionStart：週回顧到期提醒
  log-session.ps1      SessionEnd：工作日誌
  settings.hooks.json  hooks 註冊片段（install 時合併進 settings.json）
scripts/
  pre-review.ps1       依專案類型分派：Go（gofmt + go vet + go build + go test，+ golangci-lint 選配）
                        / Node（依 package.json scripts 跑 lint/typecheck/build/test）；
                        兩者皆偵測不到則跳過語言檢查
examples/              驗收清單範例、專案層覆蓋機制說明
tests/run-hook-tests.ps1  hooks 測試（stdin JSON 餵入、assert 輸出）
install.ps1
```

## 安裝（Windows）

```powershell
git clone https://github.com/tian841224/claude-workflow
cd claude-workflow
.\install.ps1              # 裝到 ~/.claude
.\install.ps1 -DryRun      # 先看會動哪些檔
.\install.ps1 -Target D:\test\fake-home   # 測試安裝
```

安裝行為（冪等，重跑 = 升級）：

| 層 | 內容 | 行為 |
|---|---|---|
| kit 層 | `~/.claude/claude-workflow/`、`agents/` 五檔、`skills/{learn,evolve,tdd}`、`hooks/claude-workflow/` | 整檔覆蓋（檔頭有 managed 標記；同名的使用者自有檔案先備份 `.bak` 再覆蓋） |
| 使用者層 | `CLAUDE.md` | 只 append 一個 `<!-- claude-workflow:begin/end -->` 區塊（含 `@claude-workflow/WORKFLOW.md` import） |
| 使用者層 | `settings.json` | hooks 結構化合併：先移除 command 含 `hooks/claude-workflow` 的舊 entry 再加入新 entry，既有自有 hooks 不動；寫回前備份 |
| 專案層 | `<project>/.claude/`、專案 CLAUDE.md | 完全不碰 |

注意：settings.json 經 PowerShell 5.1 的 ConvertTo-Json 寫回後，中文會轉為 `\uXXXX` 逸出，功能無損。`install.sh`（Linux/macOS）列為 roadmap，v2 目前以 Windows 為主。

`tdd` skill（`skills/tdd/SKILL.md` + `tests.md` + `mocking.md`）會隨 `install.ps1` 整資料夾裝到 `~/.claude/skills/tdd/`；重軌 R3 實作階段已接上紅綠迴圈，seam 直接取自 R2 凍結的 `spec.md` 技術規格「測試策略與 TDD seam」段，不需臨場另外確認（見 `agents/architect.md`）。

## 流程速覽

**L0 微軌**（trivial 改動：單檔約 ≤10 行、不動邏輯分支/介面/schema，限文案/註解/設定值/typo/純樣式）：

```
主對話直接修 + 自檢 + 跑對應驗證，不 spawn agent、不出 reviewer；任何猶豫 → 升輕軌
```

**輕軌**（bug fix / 單一函式/檔案內的小改，不改契約與 schema、不涉高風險關鍵寫入路徑）：

```
L1 architect 判定 → L2 開工前列 3–5 條微驗收清單（至少一條異常/邊界）→ 實作
→ L3 pre-review + reviewer(≤2輪，跳過語言檢查時 reviewer 先人工補跑 build/test)
→ L4 逐條跑微驗收清單、全綠即證據（結果留存於回報）
```

**標準軌**（新 feature/行為變更但侷限單一模組、不改契約與 schema、需求已明確、不涉高風險路徑——填補輕軌與重軌之間的空隙）：

```
M1 architect 一次寫完 mini-spec.md（目標/非目標/TDD seam/3–6 條驗收條目）
   → 使用者一次確認即凍結
→ M2 實作（TDD seam 取自 mini-spec）→ 作者自檢
→ M3 pre-review + reviewer(≤2輪，對照 mini-spec)
→ M4 qa 逐條執行、當場判定 PASS/FAIL；含前端條目時追加 PM 畫面驗證；
   qa 加一輪探索性測試（前端做畫面探索、純後端做 edge-case 探索）
```

**重軌**（新 feature/跨模組改動 / 改 API/WS 契約 / 改 DB schema / 高風險關鍵寫入路徑），SDD／TDD 融入版：

```
R1 PM 依 SDD 完整列規格（S<n> + Given-When-Then），規格不明確處與使用者確認到
   雙方理解一致 → 商業規格寫入 spec.md
→ R2 architect 先審規格（無法實作/有風險退回 PM，≤2輪）→ 出方案+藍圖（解法明顯唯一時
   可單方案徑行）→ 補技術規格（API contract/資料型別/錯誤碼/架構/TDD seam/非功能門檻）
   → PM 隨即依技術規格 draft 展開 checklist draft → 使用者**一次確認，spec.md 與
   checklist.md 同時凍結**（每條溯源 spec: S<n>）
→ R3 實作（TDD seam 取自 spec.md）：預設單人序列；符合四判準（模組互斥、介面穩定、
   無強順序依賴、規模門檻）才拆 ≥2 個 sub task 平行——architect 協調模式拆分（R3a）
   → orchestrator fan-out 多個 architect 實作模式平行開發（R3b）→ architect 協調模式
   彙整確認全部完成＋整合一致才交棒（R3c）；任一判準不成立就走單人序列 R3
→ R4 pre-review + reviewer 審 diff 對照 spec.md/checklist（≤3輪，跳過語言檢查時
   reviewer 先人工補跑 build/test）
→ R5 驗收：後端 = qa 逐條執行 cmd、當場比對 expect 判定 PASS/FAIL（PM 不參與）
          前端 = qa browser 操作觀察畫面 + PM 對照 spec.md 畫面驗證
          qa 加一輪探索性測試（前端做畫面探索、純後端做 edge-case 探索），
          發現規格缺漏回報（不算條目失敗）
→ R6 回報 + /learn 沉澱
```

**附加 gate：PM 畫面驗證**（不是獨立軌別）——任一軌別的任務只要含前端功能修改（純樣式微調除外，那屬於 L0），流程尾端一律追加 PM 走一次畫面驗證：L0/輕軌由 PM 直接用 browser 工具核對；標準軌/重軌由 qa 先執行 ui 條目、PM 再複核。前端功能修改因此**不再是重軌的獨立判準**，改依規模落在對應軌別 + 這個附加 gate。

**中途升降軌**：實作途中才發現命中更高軌判準，立即停手宣告升軌、補走該軌缺的前置步驟（標準軌補 mini-spec、重軌補完整 spec.md 流程並凍結）再繼續；降軌需使用者同意。

任務目錄：重軌 `~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，含 `spec.md`／`checklist.md`／`plan.md`；標準軌只有單檔 `mini-spec.md`（詳見 `kit/acceptance-spec.md`）。checklist 是 spec.md 的延伸，兩者矛盾一律交使用者裁決。

**除錯/驗收迴圈**（例外路徑，不是主流程固定關卡，只在卡關時出場，見 `kit/WORKFLOW.md` 第 5 節）：`debugger`（唯讀）有兩條出場路徑——
- 路徑 A：architect 對同一 bug 用同一解法連續嘗試，第 2 次仍失敗時須先寫出「為什麼同方向再試會不同」的具體理由，寫不出即提前停手轉 debugger；理由成立可再試第 3 次，第 3 次仍未解決一律停手，揭露已嘗試的修法與失敗原因，轉交 `debugger` 做根因分析
- 路徑 B：同一驗收條目在 R4（reviewer）/R5（QA）被打回 architect 達 3 次仍失敗，改派 `debugger` 分析後，architect 依建議重新實作，該條目所屬的 R4→R5 全套重跑（不可只重跑最後一步）

兩條路徑 `debugger` 都只蒐證與驗證假說、不改 code、不下修復方案，結論交回 architect。回合計數（reviewer↔architect、PM↔architect、R4/R5 打回、R3c 打回）由 orchestrator 每輪結束記錄到 `plan.md` 的「回合記錄」段落，以檔案為準、不靠對話記憶（標準軌無 plan.md，回合次數在回報中口頭列出即可）。

## 其他 CLI 支援

repo 根目錄的 `AGENTS.md` 是給 Codex CLI 用的可攜版本，內容與 `kit/WORKFLOW.md` + 五角色定義對等，但把 hooks 硬護欄（git-guard 等）改寫成純行為約定——Codex 沒有對應的 hook 機制，靠條文自律。`install.ps1` 不處理 `AGENTS.md`，需要的話手動複製到你的 Codex 設定目錄。

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

### Agent 模型固定表（寫死於各 agent frontmatter，orchestrator 不得覆蓋）

| Agent | 模型 | 理由 |
|---|---|---|
| pm | opus | 需求理解、可行性判斷、最終驗收涉及較多推理，用高階模型降低誤判 |
| architect | sonnet | 標準實作與方案分析，日常主力模型 |
| reviewer | sonnet | 靜態審查需具體程式理解力，與 architect 對等但獨立審視 |
| debugger | sonnet | 根因分析需程式理解力，但屬唯讀輔助角色，不需 opus 等級 |
| qa | haiku | 純執行凍結清單驗證指令、收集證據，任務機械化，成本應最低 |

以上四項（回合上限、凍結原則、模型固定表、除錯迴圈）為流程骨架的強制規則，權威定義見 `kit/WORKFLOW.md`（模型固定表在前言之後、流程分級與附加 gate 在 §1、回合上限在 §5、凍結原則在 §6）；README 僅摘要供快速查閱，若與 `kit/WORKFLOW.md` 不一致，以 `kit/WORKFLOW.md` 為準。

## 客製化

kit 不含任何專案專屬內容。專案專屬的審查重點與慣例：

1. 小量補充 → 寫進專案 `CLAUDE.md` 或 auto-memory（reviewer 會主動讀取）
2. 大幅改寫角色 → `<project>/.claude/agents/<name>.md` 同名整檔覆蓋

詳見 `examples/project-overrides/README.md`。

## 測試

```powershell
.\tests\run-hook-tests.ps1     # hooks 行為測試
```

## 刻意排除

- 無 watchdog 自動監控、無排程任務——續作靠讀 acceptance 目錄 + git status 還原
- 無多產品索引（products/INDEX）——單人場景由各專案 CLAUDE.md 與 auto-memory 承擔
- 無 promptcoach——與 learn 的 feedback 分類重疊
