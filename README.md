# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式任務流程。只有實際修改 source code、可執行 script 或 test code 才使用 workflow、建立 `task.md` 並執行 Reviewer、Verifier；非程式碼修改任務直接由單一主對話處理，不載入 workflow 或角色。

## 架構

- `AGENTS.md`：常駐硬規則。
- `.agents\skills\`：共用 skill source；installer 會將所有 repo skill 同步到使用者的 `.agents\skills`。
  - `workflow/`：主流程與 `risk-flags.md`。
  - `planning/`：規劃/架構討論用；也是 `unclear_requirements` 的第一步。
  - `grill-me/`：壓力測試計畫與假設；使用者明確要求，或 `unclear_requirements` 仍有風險時用於第二步。
- `.agents\agents\reviewer.md`、`.agents\agents\verifier.md`：唯讀角色 canonical source。
- `scripts/project-resolver.ps1`：解析 project、worktree 與 active task。
- `scripts/knowledge.ps1`：按需搜尋、去重寫入與重建 knowledge index。
- `scripts/pre-review.ps1`：在審查或結案前執行 deterministic project checks。
- `hooks/git-guard.ps1`、`hooks/quality-gate.ps1`、`hooks/impact-guard.ps1`：git 安全、結案品質與影響面時序三個 hook。`impact-guard` 為 PreToolUse，`code_change: true` 且 task 的 `Impact surface` 未填時擋下 code 編輯（task 檔本身不受限，否則無法補寫）。三平台的編輯工具名稱與參數各不相同，hook 內統一處理：Claude `Edit|Write|NotebookEdit` 走 `tool_input.file_path`；Codex `apply_patch` 是 freeform tool，路徑要從 patch 的 `*** Add/Update/Delete File:` 標頭解析；Antigravity `write_to_file`／`replace_file_content`／`multi_replace_file_content` 走 `toolCall.args.TargetFile`（PascalCase，非 `file_path`）。
- `schemas/`、`templates/task.md`：Task 與遷移資料契約。
- `install.ps1`：managed-file installer。
- `migrate-v3.ps1`：一次性 v3 資料正規化遷移。

Runtime 安裝在 `~/.agent-workflow/runtime/`，使用者資料放在 `~/.agent-workflow/knowledge/`、`projects/`、`imports/`。平台目錄只保留必要入口、skill、原生角色與 hook 設定，不建立 v3 路徑 alias。

## Task

只有實際修改 source code、可執行 script 或 test code 才建立：

```text
~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md
```

同一 worktree 最多一個 `in_progress` task。Task 必須填 `code_change: true | false`：修改 source、script 或 test code 為 `true`，只改設定／文件或只執行測試、調查、code review 為 `false`。只有 `true` 強制依序執行 Reviewer、Verifier；凍結、驗收案例、browser 與風險檢查仍依 `risk_flags` 漸進增加。

### Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`external_input`、`data_write`、`security`、`refactor`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

各值的定義、對應要求與 freeze-required 詳細規則，統一記錄在 [`.agents/skills/workflow/risk-flags.md`](.agents/skills/workflow/risk-flags.md)，修改流程時只需改這一份檔案；`risk_flags` 只控制凍結、驗收案例、browser 與風險檢查等額外要求是否漸進加入，不影響 Reviewer／Verifier 是否啟動。

### 實作

- 先讀專案 instructions、相關程式、呼叫端與既有測試；只改需求直接需要的範圍，不順手重構、不擴張抽象或依賴。
- 動手改第一行 code 前先填 task 的 `Impact surface`：反向搜尋出呼叫端（記錄命令與命中數）、實際觸發入口、共用狀態，以及追不完而未確認的節點。未填時 `impact-guard` 會擋下編輯；bug 任務的診斷只需讀取與執行，不受影響。
- 修改程式後建立 execution path：從實際入口追到修改點，再追到所有重要下游終點；同時確認修改點的上游前置條件、下游契約，以及錯誤、重送、並發與異步分支。不可只看修改點到下一個呼叫點。
- 先說明必要假設與完成條件；不確定且會改變結果時才詢問使用者。
- Bug 先重現或取得足以確認根因的證據；遵循 TDD，先寫會失敗的測試再實作使其通過，最後視需要重構。
- 發現新 hard-risk flag 時先更新 task；若需凍結則停手取得使用者確認。

### Pre-review

修改完成後執行：

```powershell
& (Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\pre-review.ps1') -RepoRoot <worktree-root>
```

Go 專案執行 changed-file gofmt、vet、build、test 與可用的 golangci-lint；Node 專案執行既有 lint、typecheck、build、test scripts。其他專案可提供 `.pre-review-extra.ps1`。

- FAIL：停止，不得送 Reviewer 或設為 done；修正後重跑。
- SKIP：在 task 記錄原因與未驗證限制，不宣稱檢查通過。
- PASS：把命令與實際 checks 寫入 task 的 Validation results。

### Reviewer 與 Verifier

`code_change: true` 時依序啟動原生 `agent-workflow-reviewer`、再啟動 `agent-workflow-verifier`；兩者唯讀，輸入只帶 task、diff、必要專案規則與驗證證據。`code_change: false` 跳過兩個角色。

- Reviewer 先建立獨立脈絡：讀專案架構與功能文件（repo 根與 `docs/` 下的 architecture／overview／design／plan）、必要時以 `knowledge.ps1 -Action Search` 讀 project knowledge、並看改動檔案的 `git log -n 5`。
- Reviewer 先核對 correctness，再回報 architecture consistency、code quality and conventions、data consistency、security、risk and compatibility、performance、flow and impact completeness；不適用時標 `N/A` 並附理由。code quality 一併檢查本次行為變更是否有測試守住。
- Reviewer 不沿用 task 的敘述：必須先從改動 symbol 反向搜尋自行重建 execution path，**再**與 task 的 `Execution path` 與 `Impact surface` 對照，task 未列出的節點列為 finding，無差異時明寫。例如修改 `C` 的 `A > B > C > D` 流程，需驗證整條 `A > B > C > D`（含重要錯誤、重送、並發、異步分支），不能只審查 `C > D`。
- Reviewer 指出未列入的節點時，回填 `Impact surface` 與 `Execution path`、重評 `risk_flags`（跨出原範圍補 `cross_feature` 並依 freeze 規則停手），不得為避開 gate 而不加 flag。回填後的路徑即為唯一版本，Verifier 與下游都以它為準。
- Reviewer 有 blocker：主 agent 修正，重新執行相關驗證，再送複審。
- Verifier：Reviewer 通過後，從實際入口執行完整 path，逐條執行完成條件，補一次最可能找到 bug 的針對性探索；不得只測修改函式或只測 `C > D`；`ui` risk flag 用 browser 實際操作。
- Verifier 把問題分為實作缺陷、規格缺漏、測試缺口、環境阻塞四類；實作缺陷批次修正後重驗失敗與波及項。測試缺口在有測試基礎設施且落在本次範圍時退回補齊，否則記錄替代驗證與未覆蓋行為並寫入 knowledge，是否另開任務由使用者決定。
- 原生角色載入失敗時先執行 installer `Repair`；仍失敗才由主 agent 明確切換唯讀身分代跑，task 與回報標記 `independence: degraded`。

### 失敗與續作

- 同一修復假說失敗兩次，不再猜第三次；回到證據與根因重新診斷。
- Reviewer／Verifier 對同一問題打回三次，停止局部修補，整理證據與架構風險交使用者裁決。
- 中斷可續作用 `paused`；缺權限、環境或外部決策用 `blocked` 並記錄下一步。
- 不維護額外 state service；task.md 是唯一任務狀態來源。

### 完成

1. 對照 task 完成條件，填入 pre-review、其他實際指令、結果與未驗證限制。
2. 回填 Reviewer／Verifier 結果與 `independence` 狀態（若適用）。
3. 所有必要條件通過才將 `status` 改為 `done`；未完成不得假裝結案。
4. 回報改了什麼、驗證證據、剩餘風險與可重現的複驗方式。

## 記憶

程式任務可用少量關鍵字讀取 global 與目前 project 的相關記憶；只有發生可重用踩坑、使用者糾正、重要決策或既有認知失效時才寫入，不強制每個 task 沉澱。

```powershell
$knowledge = Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\knowledge.ps1'
& $knowledge -Action Search -Query 'installer hooks' -Limit 5
& $knowledge -Action Upsert -Scope Project -Topic 'installer-hooks' -Content '<verified knowledge>'
& $knowledge -Action Reindex -Scope All
```

Search 是關鍵字子字串比對：query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文命中率極低），結果只回 entry 第一行前 180 字，命中後要讀 `path` 全文。寫入時第一行要寫成可獨立理解的摘要句。新專案可建立 topic `project-architecture-index` 記錄架構／功能文件路徑，讓 Reviewer 不必每次重找。

### 跨平台原生記憶

各平台仍會寫自己的記憶（Codex `~/.codex/memories`、Claude 專案 `memory/`）。Search 會一併讀取並列出，標記 `scope: native`、`source: <平台>`、`status: needs_verification`，讓任一 agent 都看得到其他平台記下的事，避免跨平台記憶分歧。

原生記憶**只讀不寫**：不複製進 curated store、不改動原檔，所以各平台的功能維持原狀。自動產生的 session 摘要（`rollout_summaries`）預設排除以免淹沒命中，需要時加 `-IncludeSessionSummaries`；只要 curated 結果時加 `-ExcludeNative`。原生記憶未經整理，一律當線索、使用前回查。

Project knowledge 可直接更新；Global knowledge 需要跨專案證據與使用者同意，並傳入 `-ApprovedByUser`。`needs_verification` entry 只能作為查證線索。Script 會拒絕疑似 credential 內容，同 scope 相同內容不重複建立，同 topic 更新 native entry 並保留關聯。

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
.\install.ps1 -Action Uninstall -TargetAgent All
```

Global entrypoint 以 `C:\Users\<user>\.agents\AGENTS.md` 為 canonical source；Claude `CLAUDE.md`、Codex `AGENTS.md` 與 Antigravity `GEMINI.md` 由 installer 建立 hard link 指向同一檔案。共用 `reviewer`／`verifier` 集中在 `.agents\agents`，所有 repo skill 集中在 `.agents\skills`；Claude、Codex 與 Antigravity 的原生 skill discovery path 由 junction 指向同一份 canonical skill 目錄，不再各自維護副本。平台 Markdown／TOML 檔案是由 canonical source 產生的 adapter。三平台 unmanaged content 發生衝突時會先建立 timestamp backup 並停止，不會猜測合併。

發現尚未遷移的 v3 knowledge/history 時，installer 會阻止 activation。Uninstall 只移除 hash 未變的 managed runtime，不刪 knowledge、projects、tasks 或 imports。

## 開發檢查

測試腳本放在 `tests/`，涵蓋靜態契約、hook、knowledge、installer 與 migration。Windows PowerShell 5.1 與 PowerShell 7 應分別執行。
