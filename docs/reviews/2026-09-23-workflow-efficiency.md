# 工作流程效率審查（2026-09-23）

本輪延續 [2026-09-21 審查](2026-09-21-workflow-efficiency.md)，以 HEAD e728fbb 為依據。和前兩輪不同，本輪的依據是真實 session transcript，不是讀文件推論。使用者決定不做優化前後的 A/B 比較，所以本文不宣稱總 token 或總時間已經下降。

## 基準：9/21 修正之後的真實 managed task

| session | agent-workflow 呼叫 | `--help` | 參數或用法錯誤 | 可避免比例 |
|---|---|---|---|---|
| slotlan e4d9ff87（financial fix） | 17 | 6 | 3 | 約 53% |
| backoffice e065d668（contract fix） | 22 | 6 | 3 | 約 41% |

- 當時每輪大約要讀入 160k token 的 cache，所以每多一次往返，就多付一次這個 context 的成本。
- 較舊的 session 另有兩類問題：
  - `delivered worktree changed during evidence-run` 連續失敗 3–6 次。
  - 失敗的 gate 每次都重印約 4KB 的 `compiled`。
- 兩個 session 都有讀 evidence.md 與 review.md，但文件沒有寫出可以直接照抄的指令語法。
- 根因是 CLI 的錯誤訊息與 procedure 都缺少語法，不是 gate 本身的問題。

## 本輪修正

| 類別 | 問題 | 修正 |
|---|---|---|
| 往返 | 用錯參數後，還要再下一次 `--help` 才知道正確參數 | 未知參數的錯誤訊息直接列出合法參數 |
| 往返 | `--task-path …/task.md` 會觸發 EEXIST | `taskPath` 接受 task.md；execution-packet 與 preflight 自寫的兩份解析一併改為共用 `taskPath` |
| 往返 | 補 workflow_facts 時先誤用 reclassify | reclassify 的錯誤訊息改為指向 task-write；evidence.md 也明寫用 `task-write` |
| 返工 | attested 記錄 runtime step，要到 close-task 才失敗 | evidence-record 當場拒絕並指向 evidence-run，整批都不寫入 |
| 返工 | worktree 變動錯誤不說原因，只能盲目重跑 | 錯誤訊息列出新增或移除的路徑，或註明是命令修改了交付檔 |
| 往返 | `evidence-record --command/--exit-code/--output-digest` 沒有呼叫端，也無法滿足 runtime step | 移除這組 CLI option 與相關程式路徑 |
| 輸出 | gate 失敗時重印所有 id 清單 | `compiled` 只保留 policy_version、plan_hash、exploration_profile |
| 輸出 | pause、block、resume、supersede、waive 印出整份 task.json | 改為 `{valid, task, status, state_revision}` |
| 輸出 | plan 的 `order` 與 `selected` 內容相同 | 從 CLI 輸出與 schema 移除 `order`，runtime 內部仍保留；plan_hash 本來就不含這個欄位 |
| 誤擋 | task-guard 擋下 `pre-review --task …task.json` 這類不會寫入的 runtime 指令 | 讀取白名單加入 pre-review、execution-packet、workflow-plan、preflight |
| 探索 | file-local、高信心、local_behavior 的 financial 修正仍被強制走 expanded，並多載入 elevated 與 project-docs | 改為 focused；required evidence（含 mutation）與 Reviewer 不變，由 policy-scenarios fixture 鎖定 |
| 文件 | 每個 task 都要查指令語法 | workflow SKILL.md 加上指令卡，包含 MV4 在同一命令內改壞、測試、還原的寫法 |
| 文件 | 重複段落 | evidence.md 的 shared map、slices 改由 elevated.md 單一擁有；review.md 的 PASS 規則與 slices 時機各留一處 |
| 文件 | 矛盾或過時的敘述 | 更正「修錯字不影響 intent_hash」；plan authority 改為 task-init 的輸出；更正 architecture 的 OrchestrationEngine、hook bundle 內容、移除欄位數、run-tests 範圍；workflow-runtime 的 entrypoint 改指向 registry；更正 review.md 引用的不存在段落 |
| 常駐成本 | localization-tw description 寫「所有中文回覆」，和 AGENTS.md 衝突 | 改為翻譯或用語有疑義時才載入；manifest 同步修改，並刪除沒有程式讀取的 triggers |
| 常駐成本 | AGENTS.md 的記憶規則在 memory.md 重複 | 改為一行 pointer；architecture 的 pointer 只指向需要的段落 |
| lint | contract-lint 的 option regex 不含數字，`--expected-workspace-sha256` 被截斷後漏檢 | regex 加入數字 |
| 使用者設定 | `~/.claude/settings.json` 有一個 agent 型 Stop hook，每回合都跑一次 LLM（timeout 45 秒），和 locale-lint 重複 | 依使用者同意移除，保留 locale-lint；已先備份 |
| 工作樹 | `.agents/skills/{ponytail,push-back,design-and-refine}` 是未追蹤的空目錄 | 確認沒有檔案後刪除 |

## 查證後不做

- **memory-context 改走小 hook bundle**：實測 25 次取中位數。
  - memory-context 從 220ms 降到 214ms。
  - hook bundle 從 28KB 增加到 352KB，git-guard 因此從 66ms 增加到 71ms，而 git-guard 每次工具呼叫都會執行。
  - Node 啟動本身約 180ms，是時間的主體，所以已回退。
- **Codex git-guard matcher 從 `*` 收窄**：Codex 原始碼證實 shell 工具的 hook 名稱是 `Bash`，apply_patch 另有 Write／Edit 別名。不過 write_stdin 可以把 git 指令送進執行中的 shell，而且查不到 MCP 工具的 hook 名稱格式，收窄可能漏擋，所以維持 `*`。

## 仍未解決

- 移除 agent 型 Stop hook 之後，「應該用中文卻整段用英文回覆」這類情況已經沒有 hook 檢查；locale-lint 只比對詞彙。若要補，應在 locale-lint 加入確定性的語言比例檢查，而不是恢復 LLM hook。
- task-init 回傳的 procedures 路徑是 repo 相對的 `.agents/skills/...`，在目標專案中無法解析；agent 目前靠推測安裝位置找到檔案。
- 單一 risk flag 會帶來大量 evidence id，delivery-wide freshness 也屬於安全邊界，本輪維持不變。
- 已實作的修正有測試保證正確性，但仍需要接下來的真實 managed task 確認 `--help` 與參數錯誤的比例確實下降；本輪沒有量測。

## 生效條件

hooks 與 runtime 是安裝副本，要重新 build 並執行 `npm run setup` 後，實際 session 才會生效。

policy 的 exploration_profile 有變更，會改變 file-local financial task 的 plan_hash，進行中的同類 task 的 evidence 會因此失效。請在沒有進行中的 financial task 時再安裝。
