# claude-workflow v2

可攜的 Claude Code 開發流程 kit：五角色 subagent（architect / reviewer / qa / pm / debugger）+ 流程分級（輕軌/重軌，重軌為 SDD／TDD 融入版）+ 後端化驗收證據 + hooks 硬護欄 + 自我學習迴圈（learn / evolve）+ TDD 紅綠迴圈（tdd skill）。

v2 的核心理念：**確定性下沉**——凡是能用腳本或 hook 保證的，不寫成條文；條文只留給機器判不了的判斷。

## 與 v1 的差異

| v1 問題 | v2 對策 |
|---|---|
| 流程 gate 全靠模型自律 | 三支 hooks（git-guard / post-edit-check / stop-check）+ pre-review 寫死在 reviewer 第一步 |
| 功能軌 F1–F10 對後端太重 | 流程分級：輕軌 4 階段（L1–L4）免 PM/QA；重軌 6 階段（R1–R6）才走完整凍結流程 |
| 證據=截圖、驗收語彙偏前端 | 前後端雙流程：後端驗收 = e2e 指令證據（go test / curl / SQL），不跑畫面；前端才做畫面驗證 |
| state JSON checkpoint 靠模型維護 | 砍除。狀態 = acceptance 目錄本身（checklist 勾選 + evidence + plan.md），stop-check hook 掃檔案抓漏 |
| inbox 學習中介與內建記憶重複 | 收編實戰版 learn / evolve skill（直接寫記憶檔、核准制升級），砍 inbox / rules/learning.md |
| Merge-Markdown 按標題合併脆弱 | 分層安裝：kit 層整檔覆蓋、使用者層只 append marker 區塊、settings.json 走結構化 JSON 合併 |

v1 → v2 步驟對照：技術軌 T1–T5 → 輕軌 L1–L4；功能軌 F1–F10 → 重軌 R1–R6（F9 併入驗收、F10 簡化為收尾）。

## 目錄結構

```
kit/
  WORKFLOW.md          流程總控（分級、階段、回合上限、凍結原則、續作）
  acceptance-spec.md   驗收規約（checklist 格式、證據規則——人與腳本共同遵守）
  templates/           spec.md / checklist.md / plan.md 模板
agents/                architect / reviewer / qa / pm / debugger 五角色定義
                        （模型固定：pm=opus、qa=haiku、architect/reviewer/debugger=sonnet，寫死於各檔 frontmatter `model:`）
skills/                learn（經驗擷取）/ evolve（週回顧精煉）/ tdd（red→green 測試紀律，含 tests.md / mocking.md，seam 取自 spec.md 技術規格）
hooks/
  git-guard.ps1        PreToolUse：破壞性 git 操作 deny、commit/push 每次 ask
  post-edit-check.ps1  PostToolUse：.go 檔編輯後 gofmt/go vet 快檢，失敗立即打回
  stop-check.ps1       Stop：session 結束前掃驗收缺件提醒
  weekly-review-check.ps1  SessionStart：週回顧到期提醒
  log-session.ps1      SessionEnd：工作日誌
  settings.hooks.json  hooks 註冊片段（install 時合併進 settings.json）
scripts/
  pre-review.ps1       gofmt + go vet + go build + go test（+ golangci-lint 選配）
  verify-evidence.ps1  驗收證據檢查（靜態模式 / -Rerun 重跑模式）
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

**輕軌**（bug fix / 單模組小改，不改契約與 schema、不涉關鍵寫入路徑）：

```
L1 architect 判定 → L2 實作 → L3 pre-review + reviewer(≤2輪) → L4 go test 全綠即證據
```

**重軌**（新 feature / 跨模組 / 改 API/DB / 關鍵寫入路徑 / 前端功能），SDD／TDD 融入版：

```
R1 PM 依 SDD 完整列規格（S<n> + Given-When-Then），規格不明確處與使用者確認到
   雙方理解一致 → 商業規格寫入 spec.md
→ R2 architect 先審規格（無法實作/有風險退回 PM，≤2輪）→ 出方案+藍圖 → 補技術規格
   （API contract/資料型別/錯誤碼/架構/TDD seam/非功能門檻）→ spec.md 凍結
   → PM 依 spec.md 展開並凍結 checklist（每條溯源 spec: S<n>）
→ R3 實作（TDD seam 取自 spec.md）：可拆多 sub task 平行——architect 協調模式拆出
   ≥2 個模組互斥的 sub task（R3a）→ orchestrator fan-out 多個 architect 實作模式
   平行開發（R3b）→ architect 協調模式彙整確認全部完成＋整合一致才交棒（R3c）；
   拆不出獨立 sub task 就退回單人序列 R3
→ R4 pre-review + reviewer 審 diff 對照 spec.md/checklist（≤3輪）
→ R5 驗收：後端 = qa 逐條跑 cmd 收證據 + verify-evidence.ps1（PM 不參與）
          前端 = qa browser 截圖 + PM 對照 spec.md 畫面驗證
          qa 加一輪探索性測試，發現規格缺漏回報（不算條目失敗）
→ R6 回報 + /learn 沉澱
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，含 `spec.md`／`checklist.md`／`plan.md`／`evidence/`（詳見 `kit/acceptance-spec.md`）。checklist 是 spec.md 的延伸，兩者矛盾一律交使用者裁決。

**除錯/驗收迴圈**（例外路徑，不是主流程固定關卡，只在卡關時出場，見 `kit/WORKFLOW.md` 第 4 節）：`debugger`（唯讀）有兩條出場路徑——
- 路徑 A：architect 對同一 bug 用同一解法連續嘗試 3 次仍未解決，即停手並揭露已嘗試的修法與失敗原因，轉交 `debugger` 做根因分析
- 路徑 B：同一驗收條目在 R4（reviewer）/R5（QA）被打回 architect 達 3 次仍失敗，改派 `debugger` 分析後，architect 依建議重新實作，該條目所屬的 R4→R5 全套重跑（不可只重跑最後一步）

兩條路徑 `debugger` 都只蒐證與驗證假說、不改 code、不下修復方案，結論交回 architect。

## 其他 CLI 支援

repo 根目錄的 `AGENTS.md` 是給 Codex CLI 用的可攜版本，內容與 `kit/WORKFLOW.md` + 五角色定義對等，但把 hooks 硬護欄（git-guard 等）改寫成純行為約定——Codex 沒有對應的 hook 機制，靠條文自律。`install.ps1` 不處理 `AGENTS.md`，需要的話手動複製到你的 Codex 設定目錄。

### 回合上限（超限一律停下交使用者裁決，不自行加碼）

| 計數器 | 上限 | 誰維護 | 超過後動作 |
|---|---|---|---|
| reviewer ↔ architect | 重軌 ≤3 輪、輕軌 ≤2 輪 | orchestrator | 列出爭點回報使用者裁決 |
| PM ↔ architect（需求可行性往返） | ≤2 輪 | orchestrator | 回報使用者裁決 |
| 同一 bug 內部修復嘗試 | 3 次 | architect 自己計數 | 轉交 `debugger`（路徑 A） |
| 同一驗收條目在 R4/R5 被打回 architect | 3 次 | orchestrator | 轉交 `debugger`（路徑 B），修復後 R4→R5 全套重跑 |
| pre-review 失敗退回 | 不計數 | — | 修正後重跑，不計入 reviewer 輪數 |

### 凍結原則（抉擇一旦定案不可中途變更）

- checklist 標記 `frozen:` 日期後，開發期間任何角色（含 PM 自己）不得增刪修改條目
- 需求變更 → 回 R1 重新出清單，舊檔加 `.superseded` 字尾，不可就地覆蓋
- 經使用者核准的修訂寫入 checklist 檔尾的「修訂歷史」，保留可追溯軌跡

### Agent 模型固定表（寫死於各 agent frontmatter，orchestrator 不得覆蓋）

| Agent | 模型 | 理由 |
|---|---|---|
| pm | opus | 需求理解、可行性判斷、最終驗收涉及較多推理，用高階模型降低誤判 |
| architect | sonnet | 標準實作與方案分析，日常主力模型 |
| reviewer | sonnet | 靜態審查需具體程式理解力，與 architect 對等但獨立審視 |
| debugger | sonnet | 根因分析需程式理解力，但屬唯讀輔助角色，不需 opus 等級 |
| qa | haiku | 純執行凍結清單驗證指令、收集證據，任務機械化，成本應最低 |

以上四項（回合上限、凍結原則、模型固定表、除錯迴圈）為流程骨架的強制規則，權威定義見 `kit/WORKFLOW.md`（模型固定表在前言之後、回合上限在 §4、凍結原則在 §5）；README 僅摘要供快速查閱，若與 `kit/WORKFLOW.md` 不一致，以 `kit/WORKFLOW.md` 為準。

## 客製化

kit 不含任何專案專屬內容。專案專屬的審查重點與慣例：

1. 小量補充 → 寫進專案 `CLAUDE.md` 或 auto-memory（reviewer 會主動讀取）
2. 大幅改寫角色 → `<project>/.claude/agents/<name>.md` 同名整檔覆蓋

詳見 `examples/project-overrides/README.md`。

## 測試

```powershell
.\tests\run-hook-tests.ps1     # hooks 行為測試（25 cases）
```

## 刻意排除

- 無 watchdog 自動監控、無排程任務——續作靠讀 acceptance 目錄 + git status 還原
- 無多產品索引（products/INDEX）——單人場景由各專案 CLAUDE.md 與 auto-memory 承擔
- 無 promptcoach——與 learn 的 feedback 分類重疊
