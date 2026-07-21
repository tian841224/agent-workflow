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

## 3. 重軌（R1–R6）

```
R1 需求凍結：PM 整理需求 → 使用者確認 → 凍結 checklist.md（格式見 acceptance-spec.md）
R2 方案與藍圖：architect 出 2-3 方案 → 使用者選定 → 寫 plan.md
R3 實作：architect 實作 + 作者自檢（不 commit）
R4 靜態把關：pre-review.ps1 通過 → reviewer 審查（≤3 輪）
R5 驗收與證據：
   - 後端條目：qa 逐條跑 cmd 收證據 → verify-evidence.ps1 全 PASS（PM 不參與驗證）
   - 前端條目：qa browser 操作+截圖 → PM 畫面驗證
R6 收尾：回報使用者（改了什麼、驗收結果、複驗方式）＋ /learn 沉澱
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/`（見 acceptance-spec.md）。
主對話在每階段結束時勾選 plan.md 的階段 checkbox；漏勾由 stop-check hook 在 session 結束時提醒。

## 4. 回合上限

- reviewer ↔ architect：重軌 ≤3 輪、輕軌 ≤2 輪；超限停止，列出爭點交使用者裁決
- PM ↔ architect（R1/R2 需求可行性往返）：≤2 輪；超限交使用者裁決
- pre-review 失敗退回修正不計入 reviewer 輪數
- 除錯同一方法最多 3 次；仍未解決即停止當前方向，轉交 `debugger` agent（唯讀）做根因分析，architect 依建議重新實作

## 5. 凍結原則

- checklist 凍結後（`frozen:` 填日期）開發期間任何角色不得增刪修改條目
- 需求變更 → 回 R1 重出清單，舊檔加 `.superseded` 字尾
- 經使用者核准的修訂寫入 checklist 檔尾「修訂歷史」

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
