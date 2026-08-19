# coordinator／worker 編排

這是 optional orchestration skill。每個 code task 開始前先做輕量拆分評估；只有評估為適合且使用者確認平行處理後，才載入本檔、建立至少兩個互不重疊且可獨立驗收的 code worker，並執行下列 lifecycle。未確認前不得建立 detached worktree；不適合、使用者拒絕或未確認時，直接走一般循序 workflow。各 worker 在 detached worktree 執行 workflow，成果以 patch 移植回主工作目錄的未提交變更；不建 branch、不 commit。

## 執行模式與平台支援

v1 只有 **Manual** 模式：`orchestrate.py` 不啟動 agent，由使用者或外部 agent 以 worker worktree 為 cwd 啟動每個 worker。

| 平台 | 狀態 |
|---|---|
| Claude Code | Manual 可用。自動 fan-out **不支援**：sub-agent 的 cwd 固定為主 repo，`cd` 不改變 hook 看到的 cwd，guard 會對錯 task。 |
| Codex | sequential fallback，未驗證 |
| Antigravity | sequential fallback，未驗證 |

## 拆分條件

寫成 split plan JSON 交 `split-plan.py` 判定，`Init` 只在 `eligible` 為 true 時才建立任何東西：

```json
{ "user_confirmed": true, "shared_persistent_state": false, "has_order_dependency": false,
  "workers": [ { "id": "payment", "title": "...", "estimated_units": 3,
                 "file_ownership": ["src/payment/", "tests/payment/"] } ] }
```

檢查項目：coordinator 已 freeze 且 `subtask_role: coordinator`、使用者已確認、無共用持久化狀態、無順序依賴、至少兩個 worker、每個 worker 達最小規模、ownership 文法合法且 pairwise disjoint、未觸及預設序列處理的共用註冊點（schema、contract、route table、barrel index、DI registration、lockfile、i18n）。

另由 `Init` 檢查：有可用 `HEAD`、非 bare／submodule／sparse／LFS repo、untracked 檔不落在任何 ownership 內、worktree 可執行必要驗證（新 worktree 沒有 `node_modules`／`.env`／build cache；可用 `.agent-workflow-worktree-init.py` 補，否則在 worker task 記錄限制）。

任一不成立退回單一 worker 循序處理。

### `.agent-workflow-worktree-init.py` 契約

放在**目標 repo 根目錄**；`Init` 對每個新 worktree 呼叫 `& <repo根>\.agent-workflow-worktree-init.py -WorktreePath <worktree 絕對路徑>`，補回裸 `git worktree add` 沒有的 `node_modules`／`.env`／build cache。**收尾後 `git status --porcelain` 必須是空的**——這是唯一被檢查的契約，不看 exit code；腳本只能建在已 `.gitignore` 的位置，留下未忽略的新檔會讓 `Init` 直接 `Fail` 並列出髒污清單。不存在時整段跳過，worker task 需自行記錄因此受限的驗證項目。

```text
param([Parameter(Mandatory)][string]$WorktreePath)
$repoRoot = Split-Path -Parent $PSCommandPath
foreach ($dep in @('node_modules', '.env')) {
    $source = Join-Path $repoRoot $dep
    $target = Join-Path $WorktreePath $dep
    if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath $target)) {
        if ((Get-Item -LiteralPath $source).PSIsContainer) {
            New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        } else {
            Copy-Item -LiteralPath $source -Destination $target
        }
    }
}
```

## base commit

`Init` 以 `git stash create` 取得 base（乾淨時退回 `HEAD`），worker worktree 從它建立，因此 **worker 看得到主工作目錄的未提交修改**，不存在 stale baseline。`stash create` 只記錄 tracked 修改，所以 untracked 檔與 ownership 有交集時直接拒絕拆分——worker 看不到那個檔，會重新建立，`git apply` 就會撞上已存在的檔案。

base 同時是 worker 的 Reviewer diff 基準：`git diff <base_commit>`，不是 `git diff HEAD`。

`Init` 另存 HEAD／worktree／index 三個指紋。`Apply` 在尚未套用任何 delivery 時比對，確認主工作目錄自 `Init` 後沒被動過。**進入 `conflicted` 後不再比對**：手動合併本來就會改動主工作目錄，改由每份 delivery 自己的 `git apply --check` 把關。這是明確取捨。

## file_ownership

inline array（`file_ownership: [src/payment/, tests/payment/]`），repo-relative prefix，不支援 glob。目錄以 `/` 結尾，單檔不加尾端 `/`；不可為 absolute、不可含 `\`、`./` 起始、`..`、`,`、`[`、`]`。Windows 比對大小寫不敏感。

## 生命週期

```text
Init     split-plan 資格檢查 -> repo 形態檢查 -> stash create 取 base
         -> untracked x ownership 檢查 -> 建 detached worktree -> 註冊 worktree
         -> 建 worker task（含 base_commit）-> 選用 bootstrap -> 斷言 worktree clean
         -> 寫 orchestration.json
Manual   使用者以各 worktree 為 cwd 啟動 worker，worker 跑完整 workflow 並更新自己的 task
Collect  只對 status: done 執行；先跑 check-task -Mode Worker
         暫存 GIT_INDEX_FILE 產生 patch（--binary --full-index --no-renames，不動 worker index）
         計算 changed paths、patch SHA-256、out_of_scope；寫 delivery.json
Apply    首次才驗指紋 -> 集中判定跨 worker overlap -> 依 task id 排序逐一套用
         -> 衝突或 out_of_scope 者維持 pending，不自動 rejected（衝突另記入 conflicts[]）並轉 conflicted
Resolve  人工合併完成、且該路徑相對 base_commit 確有差異後標 merged
Reject   使用者決定丟棄某份 pending delivery（out_of_scope 或衝突皆可）
         Resolve／Reject 後重新收斂：全部終態時 integration_status = applied
Cleanup  重算 patch 比對 SHA 相符才移除 worktree
整合      填 Impact surface 與 Execution path -> pre-review -> Reviewer -> Verifier
```

`Status` 是唯讀診斷，不改狀態、不自動清理。

## 狀態

| worker status | 意義 |
|---|---|
| `done` | 已交付，可 Collect |
| `blocked` | 缺 ownership 或需使用者決策；在**原 worktree fix-forward**，不建 retry attempt |
| `superseded` | 使用者取消該範圍，delivery 標 `skipped` |
| `paused`／`in_progress` | 仍在進行，禁止 Collect 與 Apply |

| delivery_status | 意義 |
|---|---|
| `pending` | 已收集、尚未套用，或套用時遇衝突正等待人工合併 |
| `applied` | `git apply` 乾淨套用 |
| `merged` | 衝突後由 coordinator 人工合併 |
| `rejected` | 使用者明確決定丟棄這份交付 |
| `skipped` | 使用者取消該 worker 的範圍 |

| integration_status | 意義 |
|---|---|
| `pending` | 尚未套用任何 delivery |
| `conflicted` | 有 delivery 需要人工合併 |
| `applied` | 全部處理完畢，可進整合驗證 |
| `abandoned` | 使用者放棄 |

`conflicted` 與 `abandoned` 不得 `done`。

## 衝突合併

overlap 或 `git apply --check` 失敗時**不自動 rejected**：該 delivery 維持 `pending`，衝突路徑記入 `orchestration.json` 的 `conflicts[]`，coordinator 轉 `conflicted`。

```text
coordinator 讀兩側 patch 與主工作目錄現況，人工合併
-> 無法判定是否保留某段時，主動詢問使用者
-> 把衝突路徑、合併取捨與使用者答覆寫進 Delivery log
-> orchestrate.py -Action Resolve -WorkerId <id>
   （驗證 changed paths 都已反映在主工作目錄，才標 merged）
```

**impact-guard 的具名例外**：coordinator 平時完全不得改主工作目錄 source。唯一例外是 `integration_status: conflicted` **且**目標路徑在 `conflicts[]` 內；其餘一律 deny，衝突清空後例外自動關閉。已套用的變更不自動 rollback。此例外限制的是能改哪些路徑，不是限制 coordinator 本身——`orchestration.json` 與 `integration_status` 都在 coordinator 自己可寫的目錄下，見「已知限制」。

不合併時：`orchestrate.py -Action Reject -WorkerId <id>`，把該 delivery 標 `rejected`、從 `conflicts[]` 移除，並依 roster 現況重新收斂 `integration_status`。

**Apply 失敗時 coordinator 的 `status` 不會被自動改動**：out_of_scope 或空 patch 都只讓對應動作 `Fail`，`in_progress` 保持不變，以免 coordinator 因為自動轉 `blocked` 而被 `active_tasks` 排除、連修正用的動作都跑不了。是否要人工把 `status` 改成 `blocked` 交由使用者判斷。

## out_of_scope 的裁決

worker 越界時 impact-guard 會當場擋下（見 worker.md 的 `ownership_request`）。Collect 的 `out_of_scope` 是第二層，涵蓋 script 寫檔等 hook 看不到的路徑。發現時停下交使用者裁決，不自動 rejected：

1. 擴大 ownership 後重新 Collect —— 擴大後不得與其他 worker 衝突；碰到拆分禁止項目直接退回循序；在 `Delivery log` 記錄裁決、原／新 ownership 與理由。
2. `orchestrate.py -Action Reject -WorkerId <id>`，改走循序 task。

## abandoned

順序不可顛倒：先設 `integration_status: abandoned` → coordinator 維持 `in_progress` 執行 Cleanup → 最後才設 `blocked`／`superseded`。終態一律最後才設，否則 Cleanup 的入口驗證會擋住自己。

## 縮減交付範圍的 freeze 例外

使用者明確取消某個 worker 的範圍會改動已凍結的完成條件。允許原地更新 `Decomposition plan` 與 `Completion criteria`、補 `User confirmation`、重填 `frozen_at`，取代 supersede —— 編排中途 supersede 會讓所有 worker 的 `parent_task_id` 指向失效 task。

適用條件：只縮不擴、只由使用者發起、coordinator 已在編排中。其餘需求變更仍照 `risk-flags.md` supersede。

## Manual handoff

coordinator 為每個 worker 輸出下列資訊並寫入 `Worker results`：

```text
worker worktree 絕對路徑
worker task 絕對路徑與 task id
coordinator task id
file_ownership 與 base_commit
啟動要求：以該 worktree 為 cwd

worker role:           ~/.agents/agents/worker.md
workflow skill:        ~/.agents/skills/workflow/SKILL.md
orchestration context: ~/.agents/skills/workflow/orchestration.md
```

## 已知限制

`impact-guard` 只掛平台編輯工具，`git-guard` 只看 shell 中的 Git command。透過 PowerShell、Python 或其他 script 改檔無法完整攔截。`orchestrate.py` 的 caller 驗證只能看 cwd 與 active task，worker 切換到 coordinator 主工作目錄後無從辨識。

worker 邊界是**協作式 guard**，不具備不可繞過的保證。真正的強制需要平台層的 process identity 或 capability 機制，不在 v1 範圍。

同理，衝突合併例外（`integration_status: conflicted` + `conflicts[].paths`）**限制的是能改哪些路徑，不是限制 coordinator 本身**：`orchestration.json` 與 coordinator task 的 frontmatter 都在 coordinator 自己可寫的目錄下，coordinator 技術上可以自行宣告一個衝突來解鎖任意路徑。這與整體協作式 guard 的定位一致，不是這個例外獨有的破口。

**`quality-gate.py` 對三平台輸出同一種 `{continue:true, systemMessage}` 提示格式**：未收尾的 task 只在同一 session 內第一次遇到時提示一次，不阻斷任何一輪對話。完成把關在 `hooks/impact-guard.py` 擋下直接寫 `status: done`，以及 `scripts/close-task.py` 呼叫 `task-gate.py -Mode Close` 的硬性阻斷——兩者都與平台無關，worker／coordinator 編排在三個平台上都受它們保護。

**Antigravity 的 `systemMessage` 是否顯示未驗證**：Antigravity 官方文件（含 Context7 可查到的 CLI／IDE 文件）沒有公開 Stop 事件的 payload 與輸出契約，`adapters/antigravity/hooks.json` 裡 `Stop` 與 `PreToolUse` 也是兩種不同形狀，未經實機驗證。Antigravity 上這個提示是否真的會顯示給使用者看屬未知；Stop 本身不做阻斷，提示沒顯示只影響使用者是否看到提醒，不影響任何 gate 的強制力。
