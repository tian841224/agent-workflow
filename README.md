# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式任務流程。只有實際修改 source code 邏輯、可執行 script 或 test code 才使用 workflow、建立 `task.md` 並執行 Reviewer、Verifier；純註解修改、設定與文件修改等非程式邏輯修改任務直接由單一主對話處理，不載入 workflow 或角色。

## 架構

- `AGENTS.md`：常駐硬規則。
- `.agents\skills\`：共用 skill source；installer 會將所有 repo skill 同步到使用者的 `.agents\skills`。
  - `workflow/`：主流程、`risk-flags.md`、平行編排規則 `orchestration.md`，與專案文件規則 `project-docs.md`（分工、佈局、staleness 語意，見下方「專案文件」一節）。
  - `planning/`：規劃/架構討論用；也是 `unclear_requirements` 的第一步。
  - `grill-me/`：壓力測試計畫與假設；使用者明確要求，或 `unclear_requirements` 仍有風險時用於第二步。
- `.agents\agents\reviewer.md`、`.agents\agents\adversarial.md`、`.agents\agents\verifier.md`、`.agents\agents\retrospective.md`：唯讀角色 canonical source（`adversarial` 只在 `risk_flags` 命中 financial／data_write／migration／irreversible／schema／contract 任一時，於 Reviewer PASS 後、Verifier 之前加開；`retrospective` 只在 `change_kind: fix` 時於結案前加開，見下方「回顧」一節）。`.agents\agents\worker.md`：可寫角色，coordinator／worker 編排的 worker 端 canonical source（v1 僅 Claude 有平台 adapter）。
- `scripts/project-resolver.ps1`：解析 project、worktree 與 active task；`-RegisterWorktree` 批次註冊 worker worktree，`-RosterFor` 查詢某 coordinator 底下的 worker task 清單。
- `scripts/check-task.ps1`：coordinator／worker task 的增量檢查（`-Mode Worker|Coordinator`），供 `quality-gate.ps1` 與 `orchestrate.ps1` 共用，不重複維護規則。
- `scripts/split-plan.ps1`：拆分資格判定（freeze、使用者確認、順序依賴、共用狀態、ownership 文法與 disjoint、預設序列處理的共用註冊點），唯讀，`orchestrate.ps1 -Action Init` 的前置。
- `scripts/orchestrate.ps1`：coordinator／worker 平行編排的 Manual lifecycle（`-Action Init|Collect|Apply|Resolve|Reject|Cleanup|Status`），細節見下方「平行編排」一節。
- `scripts/knowledge.ps1`：按需搜尋、去重寫入與重建 knowledge index。
- `scripts/pre-review.ps1`：在審查或結案前執行 deterministic project checks；開頭先跑 `runtime-check.ps1`。
- `scripts/task-gate.ps1`：完成條件的單一判定來源（`-Mode Stop|Close`），`quality-gate.ps1` 與 `close-task.ps1` 共用，回傳 JSON issues。
- `scripts/close-task.ps1`：唯一可將 task 寫成 `status: done` 的入口；先跑 `task-gate.ps1 -Mode Close`，全數通過才改 frontmatter。
- `scripts/waive-roles.ps1`：唯一可寫入 `roles_waived` 的入口，要求 `-ConfirmedByUser` 與單行 `-Reason`；`impact-guard` 擋下直接編輯。豁免只放寬三個角色段落，其餘 gate 照常。
- `scripts/worktree-fingerprint.ps1`：算出「相對 base 的完整改動」sha256，含未追蹤檔；角色記錄自己審的那份指紋，收尾時重算比對，簽核後又改 code 就會被要求重跑。
- `scripts/runtime-check.ps1`：檢查防線本身——已安裝檔案的 sha256、每支 `.ps1` 的可解析性／換行／BOM、repo 與已安裝 runtime 的漂移，以及 `~/.agent-workflow/logs/hook-errors.log`。`install.ps1 -Action Verify` 走同一支。
- `hooks/git-guard.ps1`、`hooks/quality-gate.ps1`、`hooks/impact-guard.ps1`：git 安全、結案品質與影響面時序三個 hook。`impact-guard` 為 PreToolUse，`code_change: true` 且 task 的 `Impact surface` 未填時擋下 code 編輯（task 檔本身不受限，否則無法補寫）；`code_change: true` 但 task 為 coordinator 時，主工作目錄的 source 編輯一律 deny，不論 Impact surface 是否已填。三平台的編輯工具名稱與參數各不相同，hook 內統一處理：Claude `Edit|Write|NotebookEdit` 走 `tool_input.file_path`；Codex `apply_patch` 是 freeform tool，路徑要從 patch 的 `*** Add/Update/Delete File:` 標頭解析；Antigravity `write_to_file`／`replace_file_content`／`multi_replace_file_content` 走 `toolCall.args.TargetFile`（PascalCase，非 `file_path`）。`impact-guard` 另外攔截「直接把 task 的 `status` 寫成 `done`」——那是唯一不受 Stop hook 檢查的操作（Stop 只解析 `in_progress` task），一律 deny 並指向 `close-task.ps1`；`paused`／`blocked` 不受限。`git-guard.ps1` 對唯讀 Git 命令採允許清單，先判斷是否為完全唯讀組合（不需 resolve project）；worker task 下唯讀清單外一律 deny，coordinator task 下任何直接 Git 寫入一律 deny，一般 task 沿用既有 deny／ask pattern。`git-guard` 與 `impact-guard` 例外時維持 fail-open（放行），但會先把錯誤寫進 `~/.agent-workflow/logs/hook-errors.log`，讓「防線壞掉」不再無聲。
- `scripts/retro.ps1`：跨專案的框架缺口清單（`-Action Record|List|Resolve`），存放於 `~/.agent-workflow/retro/`；`Record` 回傳同類累積次數與 `escalate`，見下方「回顧」一節。
- `scripts/project-doc.ps1`：讀取目標 repo 自身 `docs/` 的專案文件（`-Action Lookup|List|Stale|Check`），依路徑反查涵蓋改動的文件並回報是否過期；不提供寫入 action，內容由 agent 直接編輯 markdown。詳見下方「專案文件」一節。
- `schemas/`、`templates/task.md`：Task 與遷移資料契約，含 coordinator／worker 的 optional 欄位（`subtask_role`、`parent_task_id`、`file_ownership`、`delivery_status`、`integration_status`）與 `change_kind`。`schemas/retro.schema.json` 是回顧詞彙（`classification`、八類 `miss_category`、`escalate_threshold`）與 finding 紀錄結構的單一來源，`task-gate.ps1` 與 `retro.ps1` 都讀它。
- `install.ps1`：managed-file installer。
- `migrate-v3.ps1`：一次性 v3 資料正規化遷移。

Runtime 安裝在 `~/.agent-workflow/runtime/`，使用者資料放在 `~/.agent-workflow/knowledge/`、`projects/`、`imports/`。平台目錄只保留必要入口、skill、原生角色與 hook 設定，不建立 v3 路徑 alias。

## Task

只有實際修改 source code、可執行 script 或 test code 才建立：

```text
~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md
```

同一 worktree 最多一個 `in_progress` task。Task 必須填 `code_change: true | false`：修改 source、script 或 test code 為 `true`，只改設定／文件或只執行測試、調查、code review 為 `false`。只有 `true` 強制依序執行 Reviewer、Verifier（命中六個高代價旗標時，中間再加一輪 Adversarial 複查）；凍結、驗收案例、browser 與風險檢查仍依 `risk_flags` 漸進增加。

`code_change: true` 時另填 `change_kind: fix | feature | refactor | chore`。它不在 schema 的 `required` 裡（既有 task 與 `orchestrate.ps1` 產生的 worker frontmatter 都沒有這個欄位），由 `task-gate.ps1 -Mode Close` 在結案時要求。

### Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

各值的定義、對應要求與 freeze-required 詳細規則，統一記錄在 [`.agents/skills/workflow/risk-flags.md`](.agents/skills/workflow/risk-flags.md)，修改流程時只需改這一份檔案；`risk_flags` 只控制凍結、驗收案例、browser 與風險檢查等額外要求是否漸進加入，不影響 Reviewer／Verifier 是否啟動；唯一例外是 Adversarial 複查，只由 `risk_flags` 觸發。

### 實作、Pre-review、角色與收尾

完整操作規則（Impact surface／execution path／TDD、pre-review 的 FAIL／SKIP／PASS、Reviewer 八面向、Adversarial 四項檢查、Verifier 分類、失敗續作、收尾與回顧步驟）以 [`.agents/skills/workflow/SKILL.md`](.agents/skills/workflow/SKILL.md) 為唯一權威，本檔不重述——README 的定位是架構導覽，不是第二份操作手冊。角色 canonical source 見上方「架構」一節；`stop_reason`、`roles_waived`、回顧迴圈的機械強制細節同樣定義在 SKILL.md 與對應的 script 裡（`task-gate.ps1`、`close-task.ps1`、`waive-roles.ps1`、`retro.ps1`）。

## 平行編排

大型 code task 可拆成多個可獨立驗收的 worker，各自在 detached worktree 執行完整既有 workflow，成果以 `git apply` 移植回主工作目錄的未提交變更；主對話改當 **coordinator**，只負責拆分、worktree／delivery 管理與整合審查，不直接改 source。v1 僅 **Manual** 模式（`orchestrate.ps1` 不啟動 agent），Claude 自動 fan-out 已證實不可行，Codex／Antigravity 為 sequential fallback。

```powershell
$rt = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts'
& "$rt\split-plan.ps1" -CoordinatorTaskPath <task.md> -PlanPath .\split-plan.json
& "$rt\orchestrate.ps1" -Action Init|Collect|Apply|Resolve|Reject|Cleanup|Status -PlanPath .\split-plan.json
```

拆分條件、生命週期各動作、狀態機、ownership 與衝突合併、impact-guard 的具名例外、`.agent-workflow-worktree-init.ps1` 契約、已知限制，完整定義在 [`.agents/skills/workflow/orchestration.md`](.agents/skills/workflow/orchestration.md)——同理，本檔不重述細節。

## 記憶

程式任務可用少量關鍵字讀取 global 與目前 project 的相關記憶；只有發生可重用踩坑、使用者糾正、重要決策或既有認知失效時才寫入，不強制每個 task 沉澱。

```powershell
$knowledge = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\knowledge.ps1'
& $knowledge -Action Search -Query 'installer hooks' -Limit 5
& $knowledge -Action Upsert -Scope Project -Topic 'installer-hooks' -Content '<verified knowledge>'
& $knowledge -Action Reindex -Scope All
```

Search 是關鍵字子字串比對：query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文命中率極低），結果只回 entry 第一行前 180 字，命中後要讀 `path` 全文。寫入時第一行要寫成可獨立理解的摘要句。專案結構與模組流程不走 knowledge，改走下方「專案文件」一節的 `project-doc.ps1`。

### 跨平台原生記憶

各平台仍會寫自己的記憶（Codex `~/.codex/memories`、Claude 專案 `memory/`）。Search 會一併讀取並列出，標記 `scope: native`、`source: <平台>`、`status: needs_verification`，讓任一 agent 都看得到其他平台記下的事，避免跨平台記憶分歧。

原生記憶**只讀不寫**：不複製進 curated store、不改動原檔，所以各平台的功能維持原狀。自動產生的 session 摘要（`rollout_summaries`）預設排除以免淹沒命中，需要時加 `-IncludeSessionSummaries`；只要 curated 結果時加 `-ExcludeNative`。原生記憶未經整理，一律當線索、使用前回查。

Project knowledge 可直接更新；Global knowledge 需要跨專案證據與使用者同意，並傳入 `-ApprovedByUser`。`needs_verification` entry 只能作為查證線索。Script 會拒絕疑似 credential 內容，同 scope 相同內容不重複建立，同 topic 更新 native entry 並保留關聯。

## 專案文件

`knowledge.ps1` 記踩坑與決策（topic 關鍵字檢索），不負責描述系統結構；`project-doc.ps1` 補這一段，記「這塊 code 是什麼、流程怎麼走」，用**路徑反查**取代關鍵字檢索。文件存在目標 repo 自身的 `docs/`（跟著 repo 與 branch 走版控），不是框架 state：

```text
docs/
├─ architecture.md        系統總覽（一份）
├─ dataflow.md             跨模組主要資料流（一份）
└─ modules/<slug>.md       模組文件（多份，need-driven）
```

Frontmatter 只兩個必填欄位：`doc_type: architecture | dataflow | module` 與 `covers: ["game/gameList/Seth_10017/"]`（repo-relative 路徑陣列，文法與 `file_ownership` 相同）。module 文件固定六區塊：`Responsibility`、`Entrypoints`、`Flow`、`Shared state`、`Invariants and gotchas`、`Unverified`；只記反向搜尋做不出來的東西（為什麼、隱藏入口），不記行號、簽名或呼叫端清單——那些 grep 一次就有且永遠最新。**不設行數上限**：篇幅過長時依 `covers` 拆成多份，而不是刪減內容。

```powershell
$pd = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\project-doc.ps1'
& $pd -Action Lookup -Paths 'game/gameList/Seth_10017/'   # 命中文件 + uncovered，附帶 architecture/dataflow
& $pd -Action Stale                                         # 只列 stale／stale_pending 的文件
```

`stale`／`stale_pending` 純由 git 歷史推導（涵蓋路徑是否在文件之後又被 commit／有未提交改動），不是可手動填的欄位，不可能被改假；未進版控的新文件一律視為最新。

**讀取與更新都有機械強制，範圍不同**：`code_change: true` 的 task 需在 `## Project docs` 記錄 `read:`（Lookup 命中並讀過的路徑，或 `none - <理由>`），未填、含 placeholder 或路徑不存在時，`impact-guard`（改 code 前）與 `task-gate.ps1 -Mode Stop`（結束 turn 前）都會擋下——這是**無條件**的，任何 code task 都要交代讀了什麼。`updated:` 由 `task-gate.ps1 -Mode Close` 強制，但是**有條件**的：只有 `change_kind: feature｜refactor`，或 `risk_flags` 命中 `behavior_change`／`contract`／`schema`／`cross_feature` 時才檢查，純 bug fix 或 chore 不受影響，避免逼出為了過關而寫的敷衍更新。這個設計避免了本框架已知會失效的模式——`project-architecture-index` 這條純指示、無機械檢查的規則，從未被任何真實專案執行過。細節見 [`.agents/skills/workflow/project-docs.md`](.agents/skills/workflow/project-docs.md)。

## 遷移

```powershell
.\migrate-v3.ps1 -Action Inventory
.\migrate-v3.ps1 -Action DryRun
.\migrate-v3.ps1 -Action Stage
.\migrate-v3.ps1 -Action Validate
.\migrate-v3.ps1 -Action Activate
```

有 unresolved source 時，`Activate` 會要求傳入 validation report 的 manifest hash。原始檔保留 immutable snapshot 與 SHA-256；v4 activation 後不讀 v3 格式。

## 安裝

```powershell
.\install.ps1 -TargetAgent All
.\install.ps1 -Action Status
.\install.ps1 -Action Repair -TargetAgent All
.\install.ps1 -Action Verify
.\install.ps1 -Action Uninstall -TargetAgent All
```

`-Action Verify` 唯讀，回報已安裝 runtime 是否完整、每支 `.ps1` 是否仍可解析，以及 repo 是否已經領先安裝版本（改了 repo 卻沒重裝時，實際在保護編輯的仍是舊版 hook）。不通過時 `exit 1`。

Global entrypoint 以 `C:\Users\<user>\.agents\AGENTS.md` 為 canonical source；Claude `CLAUDE.md`、Codex `AGENTS.md` 與 Antigravity `GEMINI.md` 由 installer 建立 hard link 指向同一檔案。共用 `reviewer`／`verifier` 集中在 `.agents\agents`，所有 repo skill 集中在 `.agents\skills`；Claude、Codex 與 Antigravity 的原生 skill discovery path 由 junction 指向同一份 canonical skill 目錄，不再各自維護副本。平台 Markdown／TOML 檔案是由 canonical source 產生的 adapter。三平台 unmanaged content 發生衝突時會先建立 timestamp backup 並停止，不會猜測合併。

發現尚未遷移的 v3 knowledge/history 時，installer 會阻止 activation。Uninstall 只移除 hash 未變的 managed runtime，不刪 knowledge、projects、tasks 或 imports。

## 開發檢查

測試腳本放在 `tests/`，涵蓋靜態契約、task 驗證、平行編排 lifecycle、hook、knowledge、pre-review、installer、migration 與專案文件。Windows PowerShell 5.1 與 PowerShell 7 應分別執行。
