# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式任務流程。只有實際修改「目標專案」用程式語言撰寫的 application source code 邏輯或 test code 邏輯時才使用 workflow、建立 `task.md` 並執行 Reviewer、Verifier；純註解修改、設定與文件修改、script 修改與操作等非程式邏輯修改任務直接由單一主對話處理，不載入 workflow 或角色。

## 架構
- `push-back/`: optional reasonableness check for a selected design; use it only when conventions, minimality, or complexity are in doubt.

- `AGENTS.md`：常駐硬規則。
- `.agents\skills\`：共用 skill source；installer 會將所有 repo skill 同步到使用者的 `.agents\skills`。
  - `workflow/`：主流程、`risk-flags.md`、平行編排規則 `orchestration.md`，與專案文件規則 `project-docs.md`（分工、佈局、staleness 語意，見下方「專案文件」一節）。
  - `planning/`：規劃/架構討論用；也是 `unclear_requirements` 的第一步。
  - `grill-me/`：壓力測試計畫與假設；使用者明確要求，或 `unclear_requirements` 仍有風險時用於第二步。
  - `doc-coauthoring/`：與使用者共同撰寫技術文件、決策文件、proposal 或 spec 的結構化流程（脈絡蒐集 → 逐節撰寫 → 讀者測試三階段）；跟 `project-docs.md` 定義的目標 repo `docs/` 文件無關，這個 skill 產出的是給人讀的獨立文件（PRD、design doc、RFC 等）。
- `.agents\agents\reviewer.md`、`.agents\agents\adversarial.md`、`.agents\agents\verifier.md`、`.agents\agents\retrospective.md`：唯讀角色 canonical source（`adversarial` 只在高風險 `risk_flags` 命中時，於 Reviewer PASS 後、Verifier 之前加開；`retrospective` 只在疑似 regression、同一問題反覆修正或使用者要求時加開）。`.agents\agents\worker.md`：可寫角色，coordinator／worker 編排的 worker 端 canonical source（v1 僅 Claude 有平台 adapter）。
- `scripts/project-resolver.ps1`：解析 project、worktree 與 active task；`-RegisterWorktree` 批次註冊 worker worktree，`-RosterFor` 查詢某 coordinator 底下的 worker task 清單。
- `scripts/path-grammar.ps1`：`file_ownership`／`covers` 共用的 repo-relative 路徑文法（`Test-OwnershipEntry`、`Test-PrefixOverlap`），由 `orchestrate.ps1`、`split-plan.ps1`、`project-doc.ps1`、`validate-task.ps1` dot-source，避免四份手抄副本各自漂移。
- `scripts/codex-hook-trust.ps1`：解析 `~/.codex/config.toml` 的 `[hooks.state]` 信任狀態、算出 hook trust key，由 `install.ps1`（裝完當下提示）與 `runtime-check.ps1`（每次健康檢查）共用讀取邏輯。
- `scripts/check-task.ps1`：coordinator／worker task 的增量檢查（`-Mode Worker|Coordinator`），供 legacy orchestration 共用；一般 task 不自動呼叫。
- `scripts/split-plan.ps1`：拆分資格判定（freeze、使用者確認、順序依賴、共用狀態、ownership 文法與 disjoint、預設序列處理的共用註冊點），唯讀，`orchestrate.ps1 -Action Init` 的前置。
- `scripts/orchestrate.ps1`：coordinator／worker 平行編排的 Manual lifecycle（`-Action Init|Collect|Apply|Resolve|Reject|Cleanup|Status`），細節見下方「平行編排」一節。
- `scripts/knowledge.ps1`：按需搜尋、去重寫入與重建 knowledge index。
- `scripts/pre-review.ps1`：在 code task 審查或結案前執行 deterministic project checks；非程式碼任務不因 workflow 自動呼叫。
- `scripts/task-gate.ps1`：legacy completion gate（`-Mode Stop|Close`），只供 coordinator／worker 或明確啟用的 Elevated task 使用。
- `scripts/close-task.ps1`：Elevated task 的完整結案入口；Standard task 不因它而增加流程。
- `scripts/waive-roles.ps1`：legacy gate 的角色豁免入口，仍要求 `-ConfirmedByUser` 與單行 `-Reason`。
- `scripts/worktree-fingerprint.ps1`：legacy coordinator／worker gate 的 diff 指紋工具；Standard task 不自動執行。
- `scripts/runtime-check.ps1`：legacy runtime health check；不由 Standard workflow 自動執行。`install.ps1 -Action Verify` 仍可手動使用。
- 預設只註冊 `hooks/git-guard.ps1`，保護 destructive Git 操作。`quality-gate.ps1` 與 `impact-guard.ps1` 仍保留在 runtime 作為相容性／進階編排工具，但不在一般 agent session 的 adapter 中自動執行；需要 coordinator／worker 或明確的 Elevated workflow 時才手動啟用。三平台 hook payload 差異只由 adapter 處理，README 不重複維護 hook 內部解析細節。
- `scripts/retro.ps1`：跨專案的框架缺口清單（`-Action Record|List|Resolve`），存放於 `~/.agent-workflow/retro/`；`Record` 回傳同類累積次數與 `escalate`，見下方「回顧」一節。
- `scripts/project-doc.ps1`：讀取目標 repo 自身 `docs/` 的專案文件（`-Action Lookup|List|Stale|Check`），依路徑反查涵蓋改動的文件並回報是否過期；不提供寫入 action，內容由 agent 直接編輯 markdown。詳見下方「專案文件」一節。
- `schemas/`、`templates/task.md`：Task 與遷移資料契約，含 coordinator／worker 的 optional 欄位（`subtask_role`、`parent_task_id`、`file_ownership`、`delivery_status`、`integration_status`）與 `change_kind`。`schemas/retro.schema.json` 是回顧詞彙（`classification`、八類 `miss_category`、`escalate_threshold`）與 finding 紀錄結構的單一來源，`task-gate.ps1` 與 `retro.ps1` 都讀它。
- `install.ps1`：managed-file installer。
- `migrate-v3.ps1`：一次性 v3 資料正規化遷移。

Runtime 安裝在 `~/.agent-workflow/runtime/`，使用者資料放在 `~/.agent-workflow/knowledge/`、`projects/`、`imports/`。平台目錄只保留必要入口、skill、原生角色與 hook 設定，不建立 v3 路徑 alias。

## Task

只有實際修改「目標專案」source code logic 或 test code logic 才建立：

```text
~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md
```

同一 worktree 最多一個 `in_progress` task。Task 必須填 `code_change: true | false`：只有修改「目標專案」source code logic 或 test code logic 為 `true`；script、設定、文件、註解、測試調查、除錯分析與 code review bypass workflow，不建立 task。只有 `true` 強制依序執行 Reviewer、Verifier（命中六個高代價旗標時，中間再加一輪 Adversarial 複查）；凍結、驗收案例、browser 與風險檢查仍依 `risk_flags` 漸進增加。

`code_change: true` 時另填 `change_kind: fix | feature | refactor | chore`。它不在 schema 的 `required` 裡（既有 task 與 `orchestrate.ps1` 產生的 worker frontmatter 都沒有這個欄位），由 `task-gate.ps1 -Mode Close` 在結案時要求。

### Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

各值的定義、對應要求與 freeze-required 詳細規則，統一記錄在 [`.agents/skills/workflow/risk-flags.md`](.agents/skills/workflow/risk-flags.md)，修改流程時只需改這一份檔案；`risk_flags` 只控制凍結、驗收案例、browser 與風險檢查等額外要求是否漸進加入，不影響 Reviewer／Verifier 是否啟動；唯一例外是 Adversarial 複查，只由 `risk_flags` 觸發。

### 實作、Pre-review、角色與收尾

完整操作規則（Standard／Elevated workflow、Reviewer、Verifier 與條件式風險檢查）以 [`.agents/skills/workflow/SKILL.md`](.agents/skills/workflow/SKILL.md) 為唯一權威，本檔不重述——README 的定位是架構導覽，不是第二份操作手冊。角色 canonical source 見上方「架構」一節；legacy runtime gate 僅供 coordinator／worker 或明確啟用的 Elevated task 使用。

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

各平台仍會寫自己的記憶（Codex `~/.codex/memories`、Claude 專案 `memory/`）。Search 會一併讀取並列出，標記 `scope: native`、`source: <平台>`、`status: needs_verification`，讓任一 agent 都看得到其他平台記下的事，避免跨平台記憶分歧。**Antigravity 不在此列**：其原生記憶存在 protobuf（`~/.gemini/antigravity/brain/<uuid>/`），不是 markdown，`knowledge.ps1` 讀不到；三平台只有 Codex 與 Claude 互見。

原生記憶**只讀不寫**：不複製進 curated store、不改動原檔，所以各平台的功能維持原狀。自動產生的 session 摘要（`rollout_summaries`）預設排除以免淹沒命中，需要時加 `-IncludeSessionSummaries`；只要 curated 結果時加 `-ExcludeNative`。原生記憶未經整理，一律當線索、使用前回查。

Project knowledge 可直接更新；Global knowledge 需要跨專案證據與使用者同意，並傳入 `-ApprovedByUser`。`needs_verification` entry 只能作為查證線索。Script 會拒絕疑似 credential 內容，同 scope 相同內容不重複建立，同 topic 更新 native entry 並保留關聯。

## 專案文件

`knowledge.ps1` 記踩坑與決策（topic 關鍵字檢索），不負責描述系統結構；`project-doc.ps1` 補這一段，記「這塊 code 是什麼、流程怎麼走」，用**路徑反查**取代關鍵字檢索。文件存在目標 repo 自身的 `docs/`（跟著 repo 與 branch 走版控），不是框架 state：

```text
docs/
├─ architecture.md        系統總覽（一份）
├─ dataflow.md             跨模組主要資料流（一份）
├─ modules/<slug>.md       模組文件（多份，need-driven）
└─ api/<slug>.md           API 規格（多份，need-driven；新增或修改對外端點時才建立）
```

Frontmatter 只兩個必填欄位：`doc_type: architecture | dataflow | module | api` 與 `covers: ["game/gameList/Seth_10017/"]`（repo-relative 路徑陣列，文法與 `file_ownership` 相同）。module 文件固定六區塊：`Responsibility`、`Entrypoints`、`Flow`、`Shared state`、`Invariants and gotchas`、`Unverified`；只記反向搜尋做不出來的東西（為什麼、隱藏入口），不記行號、簽名或呼叫端清單——那些 grep 一次就有且永遠最新。api 文件固定七區塊（`Endpoint`、`Auth`、`Request`、`Response`、`Errors`、`Invariants and gotchas`、`Unverified`），跟 module 文件相反，**刻意**記錄完整 request／response schema，因為 API 是對外契約，省略細節會讓呼叫端看不到變動。**不設行數上限**：篇幅過長時依 `covers` 拆成多份，而不是刪減內容。

```powershell
$pd = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\project-doc.ps1'
& $pd -Action Lookup -Paths 'game/gameList/Seth_10017/'   # 命中文件 + uncovered，附帶 architecture/dataflow
& $pd -Action Stale                                         # 只列 stale／stale_pending 的文件
```

`stale`／`stale_pending` 純由 git 歷史推導（涵蓋路徑是否在文件之後又被 commit／有未提交改動），不是可手動填的欄位，不可能被改假；未進版控的新文件一律視為最新。

**Project docs 採條件式使用**：陌生模組、架構／契約／跨功能變更或高風險 flag 才執行 Lookup 並記錄 `read:`；局部 bug fix、chore 與不依賴架構脈絡的修改以現況 code、呼叫端與測試為準。`updated:` 只在 feature、refactor 或相關 risk flag 命中時要求，避免為了過 gate 產生沒有資訊量的文件。細節見 [`.agents/skills/workflow/project-docs.md`](.agents/skills/workflow/project-docs.md)。

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

測試腳本放在 `tests/`，涵蓋靜態契約、task 驗證、平行編排 lifecycle、hook、knowledge、pre-review、installer、migration 與專案文件。Windows PowerShell 5.1 與 PowerShell 7 應分別執行。`.pre-review-extra.ps1`（repo 根目錄）依序執行 `tests/` 下全部 `run-*.ps1`；本 repo 沒有 `go.mod`／`package.json`，`pre-review.ps1` 的語言檢查一律 SKIP，這支才是本 repo 實際的 pre-review 驗證入口。
