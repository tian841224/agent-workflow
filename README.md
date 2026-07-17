# Claude Dev-Flow Kit

一份可攜的 Claude Code 設定組合（「kit」在這裡就是「一份能整包複製到任何電腦、直接安裝使用的設定/工具組合」的意思，不是 Claude Code 的專有功能），內含兩套機制：

1. **CTO 分派式標準開發流程**——主 Claude 扮演 orchestrator（CTO），依任務是「技術型」（重構/效能/架構調整，不影響功能）或「功能型」（新增/修改功能、bug fix）分流成兩條軌道，分派給 architect / reviewer / QA / PM 四個 subagent，各 gate 的通過條件、回合數上限都由骨架確定性控制。
2. **自我學習迴圈**——任務中擷取的教訓（技術陷阱、協作偏好、流程方法論）累積在收件匣，定期蒸餾成精煉記憶，重複出現的教訓升級成正式規則或 skill；另外還有一套獨立的「Prompt 教練」，用來檢討使用者自己的 prompt 撰寫習慣。

## 目錄導覽

```
claude-dev-flow/
├── CLAUDE.md              主設定檔精簡版：編排協定、標準開發流程（技術軌/功能軌）、工程紀律等
├── install.sh             安裝腳本（Git Bash / macOS / Linux）
├── install.ps1            安裝腳本（原生 PowerShell）
├── agents/                四個 subagent 定義：architect（架構師）/ pm（產品經理）/ qa（測試）/ reviewer（審查）
├── acceptance/README.md   驗收清單機制說明（三段式格式、證據落地規約）
├── scripts/                pre-review.sh（實作後確定性預檢）、verify-evidence.sh（驗收證據完整性檢查）
├── state/README.md        任務檢查點格式說明（斷線後手動接續用，不含自動監控）
├── products/INDEX.md      多產品配置索引機制（空模板，需自行登錄）
├── rules/                 learning.md（自我學習迴圈定義）、prompt-coaching.md（Prompt 教練定義）
├── skills/                learn / evolve / promptcoach 三個 skill 定義
├── memory/                MEMORY.md / inbox.md（空白模板，會隨使用累積你自己的教訓）
└── DECISION_LOG.md        跨產品決策紀錄模板（空白）
```

## 安裝方式

在目標機器的 kit 根目錄執行（預設安裝到 `~/.claude`，也可指定其他目標路徑）：

```bash
# Git Bash / macOS / Linux
./install.sh
# 或指定目標
./install.sh /path/to/.claude
```

```powershell
# 原生 PowerShell
.\install.ps1
# 或指定目標
.\install.ps1 -Dest C:\path\to\.claude
```

### 衝突時如何處理（全自動，不會跳出選項問你）

安裝腳本把檔案分三類，各自套用不同的自動化策略——**不覆蓋、不詢問，一律自動處理**：

- **Markdown 文件**（`CLAUDE.md`、`agents/*.md`、`skills/*/SKILL.md`、`acceptance/README.md`、`state/README.md`、`rules/*.md`）：依標題段落自動合併。目標檔裡有相同標題的段落 → 用 kit 最新內容取代該段落；目標檔沒有的標題 → 整段附加到檔尾。你自己在這些檔案裡寫的、kit 沒有的內容完全不會受影響。重跑安裝永遠不會造成同一段落重複出現。
- **可執行腳本**（`scripts/pre-review.sh`、`scripts/verify-evidence.sh`）：逐字比對，相同就跳過；不同的話**不會覆蓋你的原檔**，而是把 kit 版本另存成同目錄的 `pre-review.kit.sh` / `verify-evidence.kit.sh`，兩份都能獨立執行，你可以自行比對後決定要不要採用。之所以不像 markdown 一樣直接合併，是因為腳本是一整條可執行的控制流程，硬把兩段邏輯接在一起，很可能因為前段已經有 `exit` 而讓後半段變成永遠不會執行的死碼，反而是「看起來裝新了、其實沒作用」的假象。
- **資料類檔案**（`memory/MEMORY.md`、`memory/inbox.md`、`memory/prompt-coach/*.md`、`DECISION_LOG.md`、`products/INDEX.md`）：只在完全不存在時才建立，一旦存在就完全不動。這些檔案會隨使用累積你自己的真實資料（學習條目、決策紀錄、產品登錄），任何自動邏輯都不該去動它們。

安裝完成後會印出「下一步」提示：登錄你自己的產品到 `products/INDEX.md`；若有腳本以 `.kit.sh` 並存，記得找時間比對合併。

## 這個 kit 不含什麼（刻意排除）

- **看門狗自動化**：不含任何自動監控/自動復活 session 的機制。斷線後請自行 `claude --resume <session_id>` 手動接續（`state/README.md` 有說明）。
- **排程任務**：不含自動週期回顧的排程設定。若想要定期自動整理自我學習迴圈的記憶，可自行用 `/schedule` 建立一個執行 `evolve` skill 的排程任務。
- **個人化偏好**：不含原始 `~/.claude/CLAUDE.md` 裡的 `model_routing`、誠實性規範、語言規範、Git 分支慣例（特定專案的 worktree 路徑）、前端 RWD 強制引用段等只對特定使用者/專案有意義的設定。
- **任何專案的真實資料**：不含已登錄的產品配置、已累積的學習記憶條目、已寫入的決策紀錄——只有空白模板與機制說明。

## 與原始 `~/.claude` 的關係

本專案是從個人 `~/.claude` 手動導出的**靜態快照**，用於備份/分享/在新機器安裝，兩邊**不會自動同步**。若原始 `~/.claude` 之後有更新，需要人工比對後手動同步進本專案（或反向：本專案更新後，用安裝腳本重跑一次把更新合併回 `~/.claude`）。
