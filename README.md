# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式任務流程。所有程式任務使用同一種 `task.md`；只有實際修改程式碼時才執行 Reviewer、Verifier，其他 gate 依風險旗標增加。

## 架構

- `AGENTS.md`：常駐硬規則。
- `skills/workflow/SKILL.md`：唯一流程 skill。
- `agents/reviewer.md`、`agents/verifier.md`：唯讀角色 canonical source。
- `scripts/project-resolver.ps1`：解析 project、worktree 與 active task。
- `scripts/knowledge.ps1`：按需搜尋、去重寫入與重建 knowledge index。
- `scripts/pre-review.ps1`：在審查或結案前執行 deterministic project checks。
- `hooks/git-guard.ps1`、`hooks/quality-gate.ps1`：僅保留的兩個 hook。
- `schemas/`、`templates/task.md`：Task 與遷移資料契約。
- `install.ps1`：managed-file installer。
- `migrate-v3.ps1`：一次性 v3 資料正規化遷移。

Runtime 安裝在 `~/.agent-workflow/runtime/`，使用者資料放在 `~/.agent-workflow/knowledge/`、`projects/`、`imports/`。平台目錄只保留必要入口、skill、原生角色與 hook 設定，不建立 v3 路徑 alias。

## Task

程式碼／設定修改、bug fix、測試、除錯、程式調查與 code review 都建立：

```text
~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md
```

同一 worktree 最多一個 `in_progress` task。Task 必須填 `code_change: true | false`：修改 source、script 或 test code 為 `true`，只改設定／文件或只執行測試、調查、code review 為 `false`。只有 `true` 強制依序執行 Reviewer、Verifier；凍結、驗收案例、browser 與風險檢查仍依 `risk_flags` 漸進增加。

修改完成後執行：

```powershell
& (Join-Path $env:USERPROFILE '.agent-workflow\runtime\scripts\pre-review.ps1') -RepoRoot <worktree-root>
```

Go 專案執行 changed-file gofmt、vet、build、test 與可用的 golangci-lint；Node 專案執行既有 lint、typecheck、build、test scripts。其他專案可提供 `.pre-review-extra.ps1`。FAIL 不得進入 Reviewer 或結案；SKIP 必須記錄原因。

## 記憶

程式任務可用少量關鍵字讀取 global 與目前 project 的相關記憶；只有發生可重用踩坑、使用者糾正、重要決策或既有認知失效時才寫入，不強制每個 task 沉澱。

```powershell
.\scripts\knowledge.ps1 -Action Search -Query 'installer hooks' -Limit 5
.\scripts\knowledge.ps1 -Action Upsert -Scope Project -Topic 'installer-hooks' -Content '<verified knowledge>'
.\scripts\knowledge.ps1 -Action Reindex -Scope All
```

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

發現尚未遷移的 v3 knowledge/history 時，installer 會阻止 activation。Uninstall 只移除 hash 未變的 managed runtime，不刪 knowledge、projects、tasks 或 imports。

## 開發檢查

測試腳本放在 `tests/`，涵蓋靜態契約、hook、installer 與 migration。Windows PowerShell 5.1 與 PowerShell 7 應分別執行。
