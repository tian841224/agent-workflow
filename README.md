# claude-workflow v2

可攜的 Claude Code 開發流程 kit：五角色 subagent（architect / reviewer / qa / pm / debugger）+ 流程分級（輕軌/重軌）+ 後端化驗收證據 + hooks 硬護欄 + 自我學習迴圈（learn / evolve）。

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
skills/                learn（經驗擷取）/ evolve（週回顧精煉）/ tdd（red→green 測試紀律）
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
| kit 層 | `~/.claude/claude-workflow/`、`agents/` 四檔、`skills/{learn,evolve}`、`hooks/claude-workflow/` | 整檔覆蓋（檔頭有 managed 標記；同名的使用者自有檔案先備份 `.bak` 再覆蓋） |
| 使用者層 | `CLAUDE.md` | 只 append 一個 `<!-- claude-workflow:begin/end -->` 區塊（含 `@claude-workflow/WORKFLOW.md` import） |
| 使用者層 | `settings.json` | hooks 結構化合併：先移除 command 含 `hooks/claude-workflow` 的舊 entry 再加入新 entry，既有自有 hooks 不動；寫回前備份 |
| 專案層 | `<project>/.claude/`、專案 CLAUDE.md | 完全不碰 |

注意：settings.json 經 PowerShell 5.1 的 ConvertTo-Json 寫回後，中文會轉為 `\uXXXX` 逸出，功能無損。`install.sh`（Linux/macOS）列為 roadmap，v2 目前以 Windows 為主。

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
→ R3 實作（TDD seam 取自 spec.md）
→ R4 pre-review + reviewer 審 diff 對照 spec.md/checklist（≤3輪）
→ R5 驗收：後端 = qa 逐條跑 cmd 收證據 + verify-evidence.ps1（PM 不參與）
          前端 = qa browser 截圖 + PM 對照 spec.md 畫面驗證
          qa 加一輪探索性測試，發現規格缺漏回報（不算條目失敗）
→ R6 回報 + /learn 沉澱
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`，含 `spec.md`／`checklist.md`／`plan.md`／`evidence/`（詳見 `kit/acceptance-spec.md`）。checklist 是 spec.md 的延伸，兩者矛盾一律交使用者裁決。

**例外路徑**：除錯或審查/驗收迴圈連續打轉達 3 次仍失敗時，改派 `debugger`（唯讀根因分析），不是主流程的固定關卡，只在卡關時出場（見 `kit/WORKFLOW.md` 第 4 節）。

## 其他 CLI 支援

repo 根目錄的 `AGENTS.md` 是給 Codex CLI 用的可攜版本，內容與 `kit/WORKFLOW.md` + 五角色定義對等，但把 hooks 硬護欄（git-guard 等）改寫成純行為約定——Codex 沒有對應的 hook 機制，靠條文自律。`install.ps1` 不處理 `AGENTS.md`，需要的話手動複製到你的 Codex 設定目錄。

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
